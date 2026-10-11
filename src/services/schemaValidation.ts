import { dereference, Validator } from '@cfworker/json-schema'
import type { OutputUnit, Schema, SchemaDraft } from '@cfworker/json-schema'
import type { AssertionResult, Response } from '../types/request'
import { schemaMetas } from './schemaMetas.ts'
import { isExactJsonNumber, parseExactJson, stringifyResponseValue } from './responseView.ts'

type Compiled = { validator?: Validator; draft: '7' | '2020-12'; error?: string }
const compiledSchemas = new Map<string, Compiled>()
const metaValidators = new Map<SchemaDraft, Validator>()
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const detailErrors = (errors: OutputUnit[]): OutputUnit[] => {
  const details = errors.filter(error => !['$ref', 'properties', 'items', 'allOf', 'anyOf', 'oneOf'].includes(error.keyword))
  return details.length ? details : errors
}
function validatorJson(text: string): unknown {
  const value = parseExactJson(text)
  const pending: { value: unknown; path: string; parent?: Record<string, unknown>; key?: string }[] = [{ value, path: '#' }]
  while (pending.length) {
    const node = pending.pop()!
    if (isExactJsonNumber(node.value)) {
      const raw = stringifyResponseValue(node.value)
      if (/^-0(?:\.0+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
        if (!node.parent) return -0
        node.parent[node.key!] = -0
      } else throw new Error(`Number at ${node.path} cannot be represented exactly by the schema validator. Validation cannot continue without rounding.`)
    } else if (node.value !== null && typeof node.value === 'object') {
      for (const [key, child] of Object.entries(node.value)) pending.push({ value: child, path: node.path + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'), parent: node.value as Record<string, unknown>, key })
    }
  }
  return value
}

function draftOf(schema: Schema | boolean): '7' | '2020-12' {
  if (typeof schema === 'boolean' || schema.$schema === undefined) return '7'
  const uri = String(schema.$schema).replace(/#$/, '').replace(/^http:/, 'https:')
  if (uri === 'https://json-schema.org/draft-07/schema') return '7'
  if (uri === 'https://json-schema.org/draft/2020-12/schema') return '2020-12'
  throw new Error('Supported $schema dialects are draft-07 and 2020-12. Omit $schema to use draft-07.')
}

function metaValidator(draft: '7' | '2020-12'): Validator {
  const existing = metaValidators.get(draft)
  if (existing) return existing
  // The official 2020 meta-schemas use a dynamic anchor to combine vocabularies.
  // For this fixed offline bundle the target is known: the complete root meta-schema.
  const metas: Schema[] = JSON.parse(JSON.stringify(schemaMetas).replaceAll('"$dynamicRef":"#meta"', '"$ref":"https://json-schema.org/draft/2020-12/schema"'))
  const validator = new Validator(metas[draft === '7' ? 0 : 1], draft, false)
  if (draft === '2020-12') for (const meta of metas.slice(2)) validator.addSchema(meta)
  metaValidators.set(draft, validator)
  return validator
}

function compileSchema(text: string): Compiled {
  const existing = compiledSchemas.get(text)
  if (existing) return existing
  let draft: '7' | '2020-12' = '7'
  let result: Compiled
  try {
    if (new TextEncoder().encode(text).length > 1024 * 1024) throw new Error('Schema is too large. The maximum size is 1 MiB.')
    const schema = validatorJson(text) as Schema | boolean
    if (typeof schema !== 'boolean' && (schema === null || typeof schema !== 'object' || Array.isArray(schema))) throw new Error('A JSON Schema must be an object or a boolean.')
    draft = draftOf(schema)
    const checked = metaValidator(draft).validate(schema)
    if (!checked.valid) throw new Error(detailErrors(checked.errors).slice(0, 4).map(error => `${error.instanceLocation}: ${error.error}`).join('; '))
    const lookup = dereference(schema)
    for (const node of Object.values(lookup)) {
      if (typeof node !== 'object') continue
      if (Object.keys(node).some(key => key.startsWith('__absolute_'))) throw new Error('Schema contains reserved internal reference fields. Remove __absolute_* properties and use $ref.')
      if (node.$dynamicRef !== undefined || node.$dynamicAnchor !== undefined) throw new Error('$dynamicRef and $dynamicAnchor are not supported. Use ordinary $ref with local $defs.')
      if (node.$async !== undefined) throw new Error('Asynchronous schemas are not supported.')
      if (node.$schema !== undefined && draftOf(node) !== draft) throw new Error('Combining multiple schema dialects is not supported.')
      if (node.$ref !== undefined && lookup[node.__absolute_ref__ ?? node.$ref] === undefined) throw new Error(`Unresolved $ref "${node.$ref}". Include referenced schemas locally; remote schemas are never downloaded.`)
    }
    result = { draft, validator: new Validator(schema, draft, false) }
  } catch (error) { result = { draft, error: message(error) } }
  if (compiledSchemas.size >= 30) compiledSchemas.delete(compiledSchemas.keys().next().value!)
  compiledSchemas.set(text, result)
  return result
}

export function checkResponseSchema(text?: string): { valid: boolean; empty: boolean; draft: string; error?: string } {
  if (!text?.trim()) return { valid: true, empty: true, draft: '7' }
  const compiled = compileSchema(text)
  return { valid: !compiled.error, empty: false, draft: compiled.draft, error: compiled.error }
}

export function validateResponseSchema(schemaText: string | undefined, response: Response): AssertionResult[] {
  if (!schemaText?.trim()) return []
  const compiled = compileSchema(schemaText)
  if (compiled.error) return [{ name: 'JSON Schema', passed: false, actual: `Invalid schema: ${compiled.error}` }]
  let data: unknown
  try { data = validatorJson(response.body) } catch (error) { return [{ name: 'JSON Schema', passed: false, actual: error instanceof SyntaxError ? `Response body is not valid JSON: ${message(error)}` : message(error) }] }
  try {
    const result = compiled.validator!.validate(data)
    if (result.valid) return [{ name: 'JSON Schema', passed: true, actual: `Response matches draft ${compiled.draft} schema` }]
    const details = detailErrors(result.errors)
    const errors = details.slice(0, 20).map(error => ({ name: `JSON Schema ${error.instanceLocation}`, passed: false, actual: `${error.error} (${error.keywordLocation})` }))
    if (details.length > 20) errors.push({ name: 'JSON Schema', passed: false, actual: `${details.length - 20} additional validation errors omitted` })
    return errors
  } catch (error) { return [{ name: 'JSON Schema', passed: false, actual: `Unable to validate schema: ${message(error)}` }] }
}

export function inferResponseSchema(sample: string): string {
  const infer = (value: unknown, depth = 0): Schema => {
    if (depth > 100) throw new Error('Response is too deeply nested to infer a schema.')
    if (value === null) return { type: 'null' }
    if (Array.isArray(value)) {
      const unique = new Map(value.map(item => { const schema = infer(item, depth + 1); return [JSON.stringify(schema), schema] }))
      return { type: 'array', items: unique.size > 1 ? { anyOf: [...unique.values()] } : unique.size === 1 ? [...unique.values()][0] : {} }
    }
    if (typeof value === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, infer(item, depth + 1)])), required: Object.keys(value) }
    return { type: typeof value === 'number' ? Number.isInteger(value) ? 'integer' : 'number' : typeof value as 'string' | 'boolean' }
  }
  return JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', ...infer(validatorJson(sample)) }, null, 2)
}
