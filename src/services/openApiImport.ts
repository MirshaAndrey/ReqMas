import { parse } from 'yaml'
import type { AuthSettings, Method, Pair, Request } from '../types/request'
import type { ImportResult } from './postmanImport'
import { normalizeRequestQuery } from './queryParams.ts'
import { CollectionImportBudget, CollectionImportLimitError } from './importLimits.ts'

type Obj = Record<string, unknown>
export type OpenApiImportOptions = { baseUrl?: string }
const obj = (value: unknown): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const str = (value: unknown) => value == null ? '' : String(value)
const own = (value: Obj, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const pair = (key: string, value: string, enabled = true): Pair => ({ id: crypto.randomUUID(), key, value, enabled })
const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
const scalar = (value: unknown): string => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const isJson = (mime: string) => /(?:^application\/json$|\+json$)/i.test(mime.split(';')[0].trim())

/** Import one self-contained document. References never read files or access the network. */
export function importOpenApi(text: string, options: OpenApiImportOptions = {}): ImportResult {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('Specification is larger than 2 MiB. Split it into smaller self-contained documents.')
  let parsed: unknown
  try {
    const input = text.replace(/^\uFEFF/, '').trim()
    parsed = input.startsWith('{') || input.startsWith('[') ? JSON.parse(input) : parse(input, { maxAliasCount: 50, uniqueKeys: true, merge: false })
  } catch (error) { throw new Error(`Invalid JSON or YAML: ${error instanceof Error ? error.message : 'unable to parse document'}`, { cause: error }) }
  const root = obj(parsed)
  const swagger = root.swagger === '2.0'
  if (!swagger && !/^3\.(0|1)\.\d+$/.test(str(root.openapi))) throw new Error('Choose an OpenAPI 3.0/3.1 or Swagger 2.0 specification.')
  if (!own(root, 'paths') || typeof root.paths !== 'object' || root.paths === null || Array.isArray(root.paths)) throw new Error('The specification must contain a paths object.')
  // YAML aliases may create object cycles; constrain input independently of $ref handling.
  let nodes = 0
  const inspect = (value: unknown, ancestors: Set<object>, depth: number) => {
    if (++nodes > 100000 || depth > 80) throw new Error('The specification is too complex or nested too deeply.')
    if (value === null || typeof value !== 'object') return
    if (ancestors.has(value)) throw new Error('Cyclic YAML aliases are unsupported. Use local $ref references instead.')
    const next = new Set(ancestors).add(value)
    Object.values(value).forEach(child => inspect(child, next, depth + 1))
  }
  inspect(root, new Set(), 0)
  const collection = { id: crypto.randomUUID(), name: str(obj(root.info).title).trim() || 'Imported API', folders: [] as string[] }
  const result: ImportResult = { collection, requests: [], skipped: 0, warnings: [] }
  const budget = new CollectionImportBudget(collection)
  const warn = (message: string) => { if (!result.warnings.includes(message)) result.warnings.push(message) }
  const pointer = (ref: string): unknown => {
    if (!ref.startsWith('#/')) throw new Error(`Only local $ref references are supported: ${ref}`)
    let current: unknown = root
    let parts: string[]
    try { parts = decodeURIComponent(ref.slice(2)).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~')) } catch { throw new Error(`Invalid $ref: ${ref}`) }
    for (const part of parts) {
      if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) throw new Error(`Unresolved $ref: ${ref}`)
      current = (current as Obj)[part]
    }
    return current
  }
  const resolve = (value: unknown, refs: string[] = []): Obj => {
    const source = obj(value)
    if (!own(source, '$ref')) return source
    const ref = str(source.$ref)
    if (refs.includes(ref) || refs.length > 40) throw new Error(`Circular reference while reading an operation: ${ref}`)
    return { ...resolve(pointer(ref), [...refs, ref]), ...Object.fromEntries(Object.entries(source).filter(([key]) => key !== '$ref')) }
  }
  const sample = (value: unknown, refs: string[] = [], depth = 0): unknown => {
    if (depth > 30) { warn('Schema examples were limited to 30 levels of nesting.'); return null }
    if (value === false) throw new Error('A false schema cannot generate a request example.')
    const source = obj(value)
    if (own(source, 'example')) return source.example
    if (list(source.examples).length) return list(source.examples)[0]
    if (own(source, 'default')) return source.default
    if (own(source, 'const')) return source.const
    if (list(source.enum).length) return list(source.enum).find(v => v !== null) ?? null
    if (own(source, '$ref')) {
      const ref = str(source.$ref)
      if (refs.includes(ref)) { warn(`Recursive request example stopped at ${ref}; review the generated body.`); return null }
      return sample(resolve(source), [...refs, ref], depth + 1)
    }
    if (list(source.allOf).length) {
      const examples = list(source.allOf).map(s => sample(s, refs, depth + 1))
      if (examples.every(v => v !== null && typeof v === 'object' && !Array.isArray(v))) return Object.assign(Object.create(null), ...examples)
      warn('An allOf request example uses its first compatible branch; review it before sending.')
      return examples[0]
    }
    if (list(source.oneOf).length || list(source.anyOf).length) {
      warn('A oneOf/anyOf request example uses the first branch; review it before sending.')
      return sample(list(source.oneOf).length ? list(source.oneOf)[0] : list(source.anyOf)[0], refs, depth + 1)
    }
    const type = Array.isArray(source.type) ? source.type.find(t => t !== 'null') : source.type
    if (type === 'object' || source.properties) {
      const generated: Obj = Object.create(null)
      for (const [key, property] of Object.entries(obj(source.properties))) {
        if (resolve(property).readOnly === true) continue
        generated[key] = sample(property, refs, depth + 1)
      }
      return generated
    }
    if (type === 'array') {
      const count = typeof source.minItems === 'number' ? Math.min(10, Math.max(1, source.minItems)) : 1
      return Array.from({ length: count }, () => sample(source.items, refs, depth + 1))
    }
    if (type === 'integer' || type === 'number') return typeof source.minimum === 'number' ? Math.max(0, source.minimum) : 0
    if (type === 'boolean') return false
    if (type === 'null') return null
    const formats: Record<string, string> = { date: '2026-01-01', 'date-time': '2026-01-01T00:00:00Z', uuid: '00000000-0000-4000-8000-000000000000', email: 'user@example.com', uri: 'https://example.com' }
    return formats[str(source.format)] || 'string'
  }
  const example = (value: Obj, schema: unknown): unknown => {
    if (own(value, 'example')) return value.example
    const first = Object.values(obj(value.examples))[0]
    if (first) {
      const entry = resolve(first)
      if (own(entry, 'value')) return entry.value
      if (entry.externalValue) warn(`External example ${str(entry.externalValue)} was not fetched.`)
    }
    return sample(schema)
  }
  const standaloneSchema = (schema: unknown): string => {
    const defs: Obj = Object.create(null)
    const names = new Map<string, string>()
    let schemaNodes = 0
    const transform = (value: unknown, depth = 0): unknown => {
      if (++schemaNodes > 50000 || depth > 80) throw new Error('Response schema is too complex.')
      if (Array.isArray(value)) return value.map(item => transform(item, depth + 1))
      if (value === null || typeof value !== 'object') return value
      const source = obj(value)
      if (source.$schema && !['https://json-schema.org/draft/2020-12/schema', 'https://spec.openapis.org/oas/3.1/dialect/base'].includes(str(source.$schema))) warn(`Response schema dialect ${str(source.$schema)} was converted to draft 2020-12; review it before use.`)
      const out: Obj = Object.create(null)
      for (const [key, child] of Object.entries(source)) {
        if (key === '$ref') {
          const ref = str(child)
          let name = names.get(ref)
          if (!name) {
            name = `schema${names.size + 1}`; names.set(ref, name)
            defs[name] = transform(pointer(ref), depth + 1)
          }
          out.$ref = `#/$defs/${name}`
        } else if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key)) {
          out[key] = Object.fromEntries(Object.entries(obj(child)).map(([property, nested]) => [property, transform(nested, depth + 1)]))
        } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) out[key] = list(child).map(nested => transform(nested, depth + 1))
        else if (['items', 'contains', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'].includes(key)) out[key] = transform(child, depth + 1)
        else if (key === 'dependencies') out[key] = Object.fromEntries(Object.entries(obj(child)).map(([property, nested]) => [property, Array.isArray(nested) ? nested : transform(nested, depth + 1)]))
        else if (['$dynamicRef', '$recursiveRef'].includes(key)) throw new Error(`${key} is unsupported; use local $ref references.`)
        else if (!['nullable', 'example', 'xml', 'discriminator', '$schema', '$id'].includes(key)) out[key] = child
      }
      if (typeof out.exclusiveMinimum === 'boolean') { if (out.exclusiveMinimum === true && typeof out.minimum === 'number') out.exclusiveMinimum = out.minimum; else delete out.exclusiveMinimum }
      if (typeof out.exclusiveMaximum === 'boolean') { if (out.exclusiveMaximum === true && typeof out.maximum === 'number') out.exclusiveMaximum = out.maximum; else delete out.exclusiveMaximum }
      if (Array.isArray(out.required)) out.required = out.required.filter(key => resolve(obj(source.properties)[str(key)]).writeOnly !== true)
      return source.nullable === true ? { anyOf: [out, { type: 'null' }] } : out
    }
    const schemaValue = transform(schema)
    const output: Obj = typeof schemaValue === 'boolean' ? { allOf: [schemaValue] } : obj(schemaValue)
    if (Object.keys(defs).length) output.$defs = { ...obj(output.$defs), ...defs }
    output.$schema = 'https://json-schema.org/draft/2020-12/schema'
    return JSON.stringify(output, null, 2)
  }
  const fallback = str(options.baseUrl).trim() || 'https://api.example.com'
  let fallbackUrl: URL
  try { fallbackUrl = new URL(fallback) } catch { throw new Error('Fallback base URL must be an absolute HTTP or HTTPS URL.') }
  if (!['http:', 'https:'].includes(fallbackUrl.protocol) || fallbackUrl.search || fallbackUrl.hash || fallbackUrl.username || fallbackUrl.password) throw new Error('Fallback base URL must use HTTP/HTTPS without query, fragment or credentials.')
  const serverUrl = (path: Obj, operation: Obj) => {
    if (swagger) {
      const scheme = str(list(operation.schemes ?? root.schemes)[0]) || 'https'
      if (!['http', 'https'].includes(scheme)) throw new Error(`Unsupported server scheme: ${scheme}`)
      if (root.host) {
        const url = `${scheme}://${str(root.host)}${str(root.basePath)}`
        const validated = new URL(url)
        if (validated.search || validated.hash || validated.username || validated.password) throw new Error('Swagger host/basePath contains query, fragment or credentials.')
        return url.replace(/\/$/, '')
      }
      warn('Swagger host is missing; the fallback base URL was used.')
      return fallback.replace(/\/$/, '') + (str(root.basePath).startsWith('/') ? str(root.basePath) : '')
    }
    const servers = list(operation.servers ?? path.servers ?? root.servers)
    const server = obj(servers[0])
    if (servers.length > 1) warn('When several servers are declared, the first server is imported.')
    let url = str(server.url) || '/'
    url = url.replace(/\{([^{}]+)\}/g, (_, key: string) => {
      const variable = obj(obj(server.variables)[key])
      if (!own(variable, 'default')) throw new Error(`Server variable ${key} has no default.`)
      return str(variable.default)
    })
    if (!/^https?:\/\//i.test(url)) {
      warn('Relative or missing server URLs were resolved against the fallback base URL.')
      url = new URL(url, fallback.endsWith('/') ? fallback : fallback + '/').toString()
    }
    const validated = new URL(url)
    if (!['http:', 'https:'].includes(validated.protocol) || validated.search || validated.hash || validated.username || validated.password) throw new Error('Server URL must use HTTP/HTTPS without query, fragment or credentials.')
    return url.replace(/\/$/, '')
  }
  const applyAuth = (request: Request, value: unknown) => {
    request.authMode = 'none'
    const choices = list(value)
    if (!choices.length) return
    const schemes = swagger ? obj(root.securityDefinitions) : obj(obj(root.components).securitySchemes)
    const variable = (key: string) => { let name = key; while (request.variables!.some(v => v.key === name)) name += '_'; request.variables!.push(pair(name, '')); return `{{${name}}}` }
    for (const choice of choices) {
      const keys = Object.keys(obj(choice))
      if (!keys.length) return
      if (keys.length !== 1) continue
      const security = resolve(schemes[keys[0]])
      let auth: AuthSettings | undefined
      if (security.type === 'basic' || (security.type === 'http' && str(security.scheme).toLowerCase() === 'basic')) auth = { authMode: 'basic', basicAuth: { username: variable('authUsername'), password: variable('authPassword') } }
      if (security.type === 'http' && str(security.scheme).toLowerCase() === 'bearer') auth = { authMode: 'bearer', bearerToken: variable('authToken') }
      if (security.type === 'apiKey' && security.name && ['header', 'query'].includes(str(security.in))) auth = { authMode: 'apikey', apiKey: { key: str(security.name), value: variable('authApiKey'), in: security.in as 'header' | 'query' } }
      if (auth) { Object.assign(request, auth); if (choices.length > 1) warn(`${request.name}: the first supported security alternative was selected.`); warn(`${request.name}: enter authentication values in the Variables or Auth tab.`); return }
    }
    warn(`${request.name}: security requirements cannot be represented by a single Basic, Bearer or API key method. Configure authentication manually.`)
  }
  const setBody = (request: Request, media: string, definition: Obj, schema: unknown) => {
    if (media === 'application/x-www-form-urlencoded' || media === 'multipart/form-data') {
      request.bodyType = media === 'multipart/form-data' ? 'formdata' : 'urlencoded'
      request.form = []
      const properties: Obj = Object.create(null)
      const required = new Set<unknown>()
      const mergeSchema = (value: unknown, depth = 0) => {
        if (depth > 30) throw new Error('Form schema is nested too deeply or recursive.')
        const source = resolve(value)
        list(source.allOf).forEach(branch => mergeSchema(branch, depth + 1))
        Object.assign(properties, obj(source.properties))
        list(source.required).forEach(key => required.add(key))
      }
      mergeSchema(schema)
      const bodyExample = obj(example(definition, schema))
      const resolvedSchema = resolve(schema)
      const explicitExample = own(definition, 'example') || Object.keys(obj(definition.examples)).length > 0 || own(resolvedSchema, 'example') || list(resolvedSchema.examples).length > 0 || own(resolvedSchema, 'default')
      const keys = new Set([...Object.keys(properties), ...(explicitExample ? Object.keys(bodyExample) : [])])
      for (const key of keys) {
        const rawProperty = properties[key]
        const property = resolve(rawProperty)
        if (property.readOnly === true) continue
        if (property.type === 'file' || property.format === 'binary' || property.format === 'base64') { warn(`${request.name}: attach the local file for multipart field ${key} in the Body tab.`); continue }
        if (obj(definition.encoding)[key]) warn(`${request.name}: custom form encoding for ${key} must be reviewed manually.`)
        const value = own(bodyExample, key) ? bodyExample[key] : sample(property)
        const enabled = required.has(key) || explicitExample && own(bodyExample, key) || own(property, 'example') || own(property, 'default')
        if (Array.isArray(value)) value.forEach(item => request.form!.push(pair(key, scalar(item), enabled)))
        else request.form.push(pair(key, scalar(value), enabled))
      }
      return
    }
    request.headers.push(pair('Content-Type', media))
    if (isJson(media)) { request.bodyType = 'json'; request.body = JSON.stringify(example(definition, schema), null, 2); return }
    if (/xml/i.test(media)) { const value = example(definition, schema); request.bodyType = 'xml'; request.body = typeof value === 'string' ? value : ''; if (!request.body) warn(`${request.name}: XML structure is not generated from a schema; enter an XML body.`); return }
    if (/^text\//.test(media)) { request.bodyType = 'text'; request.body = scalar(example(definition, schema)); return }
    request.bodyType = 'binary'; warn(`${request.name}: attach a local binary body in the Body tab (${media}).`)
  }
  let operations = 0
  for (const [pathName, rawPath] of Object.entries(obj(root.paths))) {
    if (pathName.startsWith('x-')) continue
    if (!pathName.startsWith('/')) { warn(`Path ${pathName} is invalid and was skipped.`); result.skipped++; continue }
    let path: Obj
    try { path = resolve(rawPath) } catch (error) { result.skipped++; warn(`${pathName}: ${error instanceof Error ? error.message : String(error)}`); continue }
    if (path.trace) { result.skipped++; warn(`TRACE ${pathName}: method is unsupported and was skipped.`) }
    for (const method of methods) {
      if (!own(path, method)) continue
      if (++operations > 2000) throw new Error('More than 2000 operations. Split the specification before importing.')
      const label = `${method.toUpperCase()} ${pathName}`
      try {
        const operation = resolve(path[method])
        const folder = str(list(operation.tags)[0]).replaceAll('/', ' / ')
        const request: Request = { id: crypto.randomUUID(), collectionId: collection.id, name: str(operation.summary || operation.operationId) || label, folder, method: method.toUpperCase() as Method, url: serverUrl(path, operation) + pathName.replace(/\{([^{}]+)\}/g, '{{$1}}'), params: [], headers: [], variables: [], bodyType: 'none', body: '' }
        const parameters = new Map<string, Obj>()
        for (const raw of [...list(path.parameters), ...list(operation.parameters)]) { const p = resolve(raw); parameters.set(`${str(p.in)}:${str(p.name)}`, p) }
        const pathKeys = new Set<string>()
        const formProperties: Obj = Object.create(null)
        const formRequired: string[] = []
        for (const p of parameters.values()) {
          const name = str(p.name)
          if (!name) throw new Error('A parameter has no name.')
          const contentEntries = Object.entries(obj(p.content))
          const media = obj(contentEntries[0]?.[1])
          const schema = p.schema ?? media.schema ?? p
          const definition = own(p, 'example') || p.examples ? p : media
          const value = example(definition, schema)
          const resolvedSchema = resolve(schema)
          const enabled = p.required === true || own(definition, 'example') || own(resolvedSchema, 'example') || own(resolvedSchema, 'default') || !!p.examples
          if (p.in === 'path') { pathKeys.add(name); request.variables!.push(pair(name, encodeURIComponent(Array.isArray(value) ? value.map(scalar).join(',') : scalar(value)))); if (p.style && p.style !== 'simple') warn(`${label}: path style ${str(p.style)} for ${name} was simplified; review the URL.`); continue }
          if (p.in === 'body' && swagger) { const media = str(list(operation.consumes ?? root.consumes)[0]) || 'application/json'; setBody(request, media, p, schema); continue }
          if (p.in === 'formData' && swagger) { formProperties[name] = p; if (p.required === true) formRequired.push(name); continue }
          if (!['query', 'header'].includes(str(p.in))) { warn(`${label}: ${str(p.in)} parameter ${name} was not imported.`); continue }
          if (p.in === 'header' && ['accept', 'content-type', 'authorization'].includes(name.toLowerCase())) continue
          const target = p.in === 'query' ? request.params : request.headers
          if (Array.isArray(value)) {
            const style = str(p.style) || 'form'
            const multi = p.in === 'query' && (swagger ? p.collectionFormat === 'multi' : style === 'form' && p.explode !== false)
            const separator = p.collectionFormat === 'ssv' || style === 'spaceDelimited' ? ' ' : p.collectionFormat === 'pipes' || style === 'pipeDelimited' ? '|' : p.collectionFormat === 'tsv' ? '\t' : ','
            if (multi) value.forEach(item => target.push(pair(name, scalar(item), enabled))); else target.push(pair(name, value.map(scalar).join(separator), enabled))
          } else if (value !== null && typeof value === 'object' && p.in === 'query' && !swagger && (p.style === 'deepObject' || (p.style == null || p.style === 'form') && p.explode !== false)) {
            Object.entries(obj(value)).forEach(([key, child]) => target.push(pair(p.style === 'deepObject' ? `${name}[${key}]` : key, scalar(child), enabled)))
            if (Object.values(obj(value)).some(child => child !== null && typeof child === 'object')) warn(`${label}: nested object serialization for ${name} needs review.`)
          } else { target.push(pair(name, scalar(value), enabled)); if (value !== null && typeof value === 'object') warn(`${label}: object parameter ${name} uses JSON text; review its serialization.`) }
          if (p.allowReserved === true || p.allowEmptyValue === true) warn(`${label}: special URL encoding for ${name} needs review.`)
        }
        for (const match of pathName.matchAll(/\{([^{}]+)\}/g)) if (!pathKeys.has(match[1])) { request.variables!.push(pair(match[1], '')); warn(`${label}: path parameter ${match[1]} has no definition; enter its value in Variables.`) }
        if (Object.keys(formProperties).length) { const media = list(operation.consumes ?? root.consumes).map(str).find(m => m === 'multipart/form-data') || 'application/x-www-form-urlencoded'; setBody(request, media, {}, { type: 'object', properties: formProperties, required: formRequired }) }
        if (!swagger && operation.requestBody) {
          const body = resolve(operation.requestBody)
          const entries = Object.entries(obj(body.content))
          const chosen = entries.find(([mime]) => isJson(mime)) ?? entries[0]
          if (chosen) { const definition = obj(chosen[1]); setBody(request, chosen[0], definition, definition.schema); if (entries.length > 1) warn(`${label}: ${chosen[0]} was chosen from multiple request body formats.`) }
        }
        if (['GET', 'HEAD'].includes(request.method) && request.bodyType !== 'none') warn(`${label}: Reqmas does not send request bodies for ${request.method}; adjust the operation before sending.`)
        applyAuth(request, own(operation, 'security') ? operation.security : root.security)
        try {
          const responses = obj(operation.responses)
          const successful = Object.keys(responses).filter(code => /^2\d\d$/.test(code)).sort()
          const selectedCode = successful[0] ?? (own(responses, '2XX') ? '2XX' : own(responses, 'default') ? 'default' : undefined)
          if (selectedCode) {
            const response = resolve(responses[selectedCode])
            const responseContent = Object.entries(obj(response.content)).find(([mime]) => isJson(mime))
            const schema = swagger ? response.schema : obj(responseContent?.[1]).schema
            if (schema !== undefined) request.responseSchema = standaloneSchema(schema)
            if (successful.length > 1 || selectedCode === 'default') warn(`${label}: response schema uses ${selectedCode === 'default' ? 'the default response' : `status ${selectedCode}`}; review its applicability to other responses.`)
          }
        } catch (error) { warn(`${label}: response schema was not imported: ${error instanceof Error ? error.message : String(error)}`) }
        if (operation.callbacks) warn(`${label}: callbacks were not imported.`)
        if (folder && !collection.folders.includes(folder)) { budget.addFolder(folder); collection.folders.push(folder) }
        const normalized = normalizeRequestQuery(request)
        budget.addRequest(normalized)
        result.requests.push(normalized)
      } catch (error) { if (error instanceof CollectionImportLimitError) throw error; result.skipped++; warn(`${label}: ${error instanceof Error ? error.message : String(error)} Request skipped.`) }
    }
  }
  if (root.webhooks) warn('Webhooks were not imported. Only operations in paths become requests.')
  if (root.jsonSchemaDialect && root.jsonSchemaDialect !== 'https://spec.openapis.org/oas/3.1/dialect/base' && root.jsonSchemaDialect !== 'https://json-schema.org/draft/2020-12/schema') warn(`Custom JSON Schema dialect ${str(root.jsonSchemaDialect)} is not supported; review imported response schemas.`)
  return result
}
