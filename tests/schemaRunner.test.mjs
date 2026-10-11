import test from 'node:test'
import assert from 'node:assert/strict'
import { checkResponseSchema, inferResponseSchema, validateResponseSchema } from '../src/services/schemaValidation.ts'
import { executeRunnerRequest, parseRunnerData, runnerDelay, runnerIterationVariables } from '../src/services/runnerData.ts'
import { prepareRequest } from '../src/services/prepareRequest.ts'
import { createBackup, parseBackup } from '../src/services/backup.ts'
import { exportCollection } from '../src/services/workspace.ts'
import { importPostman } from '../src/services/postmanImport.ts'
import { normalizeRequestQuery } from '../src/services/queryParams.ts'
import { read, write, writeWorkspace } from '../src/storage/database.ts'

const response = body => ({ status: 200, statusText: 'OK', duration: 5, size: body.length, headers: { 'content-type': 'application/json' }, body })
const schema = value => JSON.stringify(value)
const pair = (key, value) => ({ id: key, key, value, enabled: true })

test('JSON Schema checks required fields, array values, formats and extra properties with useful paths', () => {
  const text = schema({ type: 'object', required: ['users'], additionalProperties: false, properties: { users: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'email'], properties: { id: { type: 'integer', minimum: 1 }, email: { type: 'string', format: 'email' } } } } } })
  assert.equal(checkResponseSchema(text).valid, true)
  assert.ok(validateResponseSchema(text, response('{"users":[{"id":1,"email":"a@example.test"}]}')).every(result => result.passed))
  const invalid = validateResponseSchema(text, response('{"users":[{"id":"1","email":"invalid"}],"extra":true}'))
  assert.ok(invalid.some(result => result.name.includes('#/users/0/id') && result.actual.includes('integer')))
  assert.ok(invalid.some(result => result.name.includes('#/users/0/email') && result.actual.includes('email')))
  assert.ok(invalid.some(result => result.actual.includes('additional')))
  assert.ok(validateResponseSchema(text, response('{}')).every(result => !result.passed))
})

test('JSON Schema supports composition and local references without retrieving remote schemas', () => {
  const text = schema({ definitions: { identifier: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^id-' }] } }, type: 'object', properties: { id: { $ref: '#/definitions/identifier' } } })
  assert.ok(validateResponseSchema(text, response('{"id":"id-123"}')).every(result => result.passed))
  assert.ok(validateResponseSchema(text, response('{"id":"bad"}')).some(result => !result.passed))
  const remote = schema({ $ref: 'https://example.invalid/schema.json' })
  assert.equal(checkResponseSchema(remote).valid, false)
  assert.match(checkResponseSchema(remote).error, /remote schemas are never downloaded/)
  const missing = schema({ $ref: '#/definitions/missing' })
  assert.equal(checkResponseSchema(missing).valid, false)
})

test('draft 2020-12 applies prefixItems and unevaluated properties and meta-validates nested schemas', () => {
  const text = schema({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { tuple: { type: 'array', prefixItems: [{ type: 'integer' }, { type: 'string' }], items: false } }, unevaluatedProperties: false })
  assert.equal(checkResponseSchema(text).valid, true)
  assert.ok(validateResponseSchema(text, response('{"tuple":[7,"seven"]}')).every(result => result.passed))
  assert.ok(validateResponseSchema(text, response('{"tuple":["7","seven",8],"extra":1}')).some(result => !result.passed))
  for (const invalid of [{ type: 'wrong' }, { properties: { id: { type: 'wrong' } } }, { prefixItems: [{ minimum: '1' }] }, { required: [5] }]) {
    assert.equal(checkResponseSchema(schema({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...invalid })).valid, false)
  }
  const refs = schema({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: { id: { type: 'integer' } }, properties: { id: { $ref: '#/$defs/id' } } })
  assert.ok(validateResponseSchema(refs, response('{"id":3}')).every(result => result.passed))
})

test('invalid schemas, unsupported dialects and non-JSON responses fail clearly; empty schemas do not add checks', () => {
  assert.deepEqual(validateResponseSchema('   ', response('plain text')), [])
  for (const text of ['{', 'null', '[]', '42', schema({ type: 'wrong' }), schema({ required: [1] }), schema({ pattern: '[' }), schema({ $schema: 'https://unknown.test/schema' }), schema({ $dynamicRef: '#meta' }), schema({ $async: true })]) {
    assert.equal(checkResponseSchema(text).valid, false, text)
    const checks = validateResponseSchema(text, response('{}'))
    assert.equal(checks.length, 1); assert.equal(checks[0].passed, false); assert.match(checks[0].actual, /Invalid schema/)
  }
  assert.match(validateResponseSchema('{"type":"object"}', response('not json'))[0].actual, /not valid JSON/)
  assert.equal(validateResponseSchema('false', response('{}'))[0].passed, false)
  assert.equal(validateResponseSchema('true', response('null'))[0].passed, true)
})

test('schema validation does not apply defaults, remove properties or coerce values and inference produces usable starters', () => {
  const res = response('{"id":"7","extra":1}')
  const before = JSON.stringify(res)
  const text = schema({ type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string', default: 'default' } }, additionalProperties: false })
  assert.ok(validateResponseSchema(text, res).some(result => !result.passed))
  assert.equal(JSON.stringify(res), before)
  const sample = '{"id":7,"values":["seven",7,null],"active":true,"items":[]}'
  const starter = inferResponseSchema(sample)
  assert.equal(checkResponseSchema(starter).valid, true)
  assert.ok(validateResponseSchema(starter, response(sample)).every(result => result.passed))
  assert.ok(validateResponseSchema(starter, response('{"id":"7"}')).some(result => !result.passed))
})

test('CSV datasets preserve BOM, CRLF, quoted commas, escaped quotes, multiline and trailing empty values', () => {
  const data = parseRunnerData('\uFEFFid,name,note,empty\r\n1,"Alice, Jr.","line one\r\nline ""two""",\r\n2,Bob,,\r\n')
  assert.equal(data.format, 'csv')
  assert.deepEqual(data.columns, ['id', 'name', 'note', 'empty'])
  assert.deepEqual(data.rows, [{ id: '1', name: 'Alice, Jr.', note: 'line one\r\nline "two"', empty: '' }, { id: '2', name: 'Bob', note: '', empty: '' }])
  assert.deepEqual(parseRunnerData('value\n""\n').rows, [{ value: '' }])
  assert.deepEqual(parseRunnerData('id,name\n\n1,Alice\n\n').rows, [{ id: '1', name: 'Alice' }])
  assert.deepEqual(parseRunnerData('id,value\n 1 , keep spaces ').rows, [{ id: ' 1 ', value: ' keep spaces ' }])
})

test('dataset parsing rejects malformed CSV, duplicate headers, wrong cell counts and oversized inputs', () => {
  for (const text of ['id,name\n1,"unclosed', 'id,name\n1,"Alice"oops', 'id,name\n1,A"lice', 'id,id\n1,2', ' id ,id\n1,2', 'id,\n1,2', 'id,name\n1', 'id,name\n1,2,3', 'id,name\n']) assert.throws(() => parseRunnerData(text), undefined, text)
  assert.throws(() => parseRunnerData('id\n' + Array.from({ length: 101 }, (_, i) => i).join('\n')), /maximum is 100/)
  assert.throws(() => parseRunnerData('id\n' + 'x'.repeat(1024 * 1024)), /maximum size/)
  assert.throws(() => parseRunnerData('id\n1', 'json'), /Invalid JSON/)
})

test('JSON datasets preserve scalar strings, null and booleans, permit sparse rows and reject nested records', () => {
  const data = parseRunnerData('[{"id":1,"enabled":true,"empty":"","value":null,"quoted":"001"},{"id":2,"name":"O\u0027Brien"}]')
  assert.equal(data.format, 'json')
  assert.deepEqual(data.columns, ['id', 'enabled', 'empty', 'value', 'quoted', 'name'])
  assert.deepEqual(data.rows[0], { id: '1', enabled: 'true', empty: '', value: 'null', quoted: '001' })
  assert.deepEqual(data.rows[1], { id: '2', name: "O'Brien" })
  for (const text of ['{}', '[]', '[null]', '[[1]]', '[{}]', '[{"id":{"nested":1}}]', '[{"id":[1]}]', '[{" id ":1,"id":2}]']) assert.throws(() => parseRunnerData(text), undefined, text)
  assert.equal(parseRunnerData('[{"id":"9007199254740993"}]').rows[0].id, '9007199254740993')
})

test('JSON datasets retain unsafe numeric IDs, precise fractions, exponents and negative zero as exact variable text', () => {
  const data = parseRunnerData('[{"id":9007199254740993,"fraction":1.00000000000000001,"overflow":1e400,"underflow":-1e-999,"zero":-0}]')
  assert.deepEqual(data.rows[0], { id: '9007199254740993', fraction: '1.00000000000000001', overflow: '1e400', underflow: '-1e-999', zero: '-0' })
  assert.equal(runnerIterationVariables(data.rows[0]).find(value => value.key === 'id').value, '9007199254740993')
})

test('schema checks refuse precision loss and injected internal reference fields instead of reporting false passes', () => {
  const unsafeSchema = '{"type":"object","properties":{"id":{"enum":[9007199254740993]}}}'
  assert.equal(checkResponseSchema(unsafeSchema).valid, false)
  assert.match(checkResponseSchema(unsafeSchema).error, /cannot be represented exactly/)
  for (const body of ['{"id":9007199254740993}', '{"id":1.00000000000000001}', '{"id":1e400}', '{"id":-1e-999}']) {
    const result = validateResponseSchema('{"type":"object"}', response(body))
    assert.equal(result[0].passed, false)
    assert.match(result[0].actual, /#\/id.*without rounding/)
  }
  assert.equal(validateResponseSchema('{"type":"number","minimum":0,"maximum":0}', response('-0'))[0].passed, true)
  const forged = schema({ $id: 'https://example.test/schema', definitions: { actual: { type: 'integer' }, fake: { type: 'string' } }, type: 'object', properties: { id: { $ref: '#/definitions/actual', __absolute_ref__: 'https://example.test/schema#/definitions/fake' } } })
  assert.equal(checkResponseSchema(forged).valid, false)
  assert.match(checkResponseSchema(forged).error, /reserved internal reference fields/)
})

test('Runner stop cancels the active request even if transport ignores the signal and rejects pre-cancelled execution', async () => {
  const controller = new AbortController()
  let childSignal
  const pending = executeRunnerRequest(async signal => { childSignal = signal; return new Promise(() => {}) }, controller.signal, 60000)
  await Promise.resolve()
  controller.abort()
  await assert.rejects(pending, /Cancelled/)
  assert.equal(childSignal.aborted, true)
  let called = false
  await assert.rejects(executeRunnerRequest(async () => { called = true }, controller.signal, 100), /Cancelled/)
  assert.equal(called, false)
})

test('Runner timeout cancels only its request and clears timers and global abort listeners after success', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const controller = new AbortController()
  let timedSignal, completedSignal
  const pending = executeRunnerRequest(async signal => { timedSignal = signal; return new Promise(() => {}) }, controller.signal, 100)
  await Promise.resolve()
  context.mock.timers.tick(100)
  await assert.rejects(pending, /Timed out after 100 ms/)
  assert.equal(timedSignal.aborted, true)
  assert.equal(controller.signal.aborted, false)
  assert.equal(await executeRunnerRequest(async signal => { completedSignal = signal; return 'next request completed' }, controller.signal, 100), 'next request completed')
  context.mock.timers.tick(1000)
  controller.abort()
  assert.equal(completedSignal.aborted, false)
})

test('Runner cancellation interrupts a long delay and does not wait for the remaining pause', async () => {
  const controller = new AbortController()
  const pending = runnerDelay(controller.signal, 60000)
  controller.abort()
  await pending
  await runnerDelay(controller.signal, 60000)
  assert.equal(controller.signal.aborted, true)
})

test('dataset variables use row values between environment and request scope without mutating saved data', () => {
  const dataset = parseRunnerData('id,name,empty\n1,Alice,\n2,Bob,')
  const request = { id: 'r', collectionId: 'c', method: 'POST', name: 'Example', url: 'https://example.test/{{id}}?empty={{empty}}', headers: [], params: [], bodyType: 'json', body: '{"name":"{{name}}"}', variables: [pair('name', 'request scope')] }
  const before = JSON.stringify({ dataset, request })
  const collection = [pair('id', 'collection'), pair('name', 'collection')]
  const environment = [pair('id', 'environment'), pair('name', 'environment'), pair('empty', 'environment')]
  const first = prepareRequest(request, collection, [...environment, ...runnerIterationVariables(dataset.rows[0])])
  const second = prepareRequest(request, collection, [...environment, ...runnerIterationVariables(dataset.rows[1])])
  assert.equal(first.url, 'https://example.test/1?empty=')
  assert.equal(second.url, 'https://example.test/2?empty=')
  assert.equal(JSON.parse(first.body).name, 'request scope')
  assert.equal(JSON.stringify({ dataset, request }), before)
  const dangerous = parseRunnerData('[{"__proto__":"safe","constructor":"value"}]')
  assert.deepEqual(runnerIterationVariables(dangerous.rows[0]).map(v => [v.key, v.value]), [['__proto__', 'safe'], ['constructor', 'value']])
  assert.equal(Object.prototype.safe, undefined)
})

const storedRequest = (id, responseSchema, extra = {}) => ({ id, collectionId: 'c', name: `Request ${id}`, method: 'GET', url: 'https://example.test/users?q=one', params: [], headers: [], bodyType: 'none', body: '', ...(responseSchema === undefined ? {} : { responseSchema }), ...extra })
const schemaText = JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', description: 'Ответ «пользователь» 🌐 {{token}}', type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }, null, 2) + '\n'
const schemaWorkspace = () => ({
  collections: [{ id: 'c', name: 'API', folders: ['Users/Details'] }],
  requests: [storedRequest('saved', schemaText), storedRequest('blank', ''), storedRequest('legacy')],
  environments: [], environmentId: '', cookies: [],
  history: [{ id: 'h', request: storedRequest('saved', schemaText), response: response('{"id":7}'), status: 200, duration: 5, time: '2026-10-06T00:00:00Z' }],
  trash: { requests: [storedRequest('deleted', 'false')], collections: [] },
})

test('workspace backups preserve schema text exactly in saved requests, drafts, history and trash', () => {
  const workspace = schemaWorkspace()
  const drafts = [storedRequest('draft', schemaText.replace('"integer"', '"string"')), storedRequest('unfinished', '{"type":')]
  const backup = createBackup(workspace, 'dark', drafts)
  workspace.requests[0].responseSchema = 'changed after export'
  drafts[0].responseSchema = 'changed after export'
  const restored = parseBackup(JSON.stringify(backup))
  assert.equal(restored.data.requests[0].responseSchema, schemaText)
  assert.equal(restored.data.requests[1].responseSchema, '')
  assert.equal(Object.hasOwn(restored.data.requests[2], 'responseSchema'), false)
  assert.equal(restored.drafts[0].responseSchema, schemaText.replace('"integer"', '"string"'))
  assert.equal(restored.drafts[1].responseSchema, '{"type":')
  assert.equal(restored.data.history[0].request.responseSchema, schemaText)
  assert.equal(restored.data.trash.requests[0].responseSchema, 'false')
  assert.ok(validateResponseSchema(restored.data.requests[0].responseSchema, response('{"id":7}')).every(result => result.passed))
  assert.ok(validateResponseSchema(restored.data.requests[0].responseSchema, response('{"id":"7"}')).some(result => !result.passed))
})

test('backup validation rejects non-string schema metadata in every request location without normalizing editable text', () => {
  const original = createBackup(schemaWorkspace(), 'system', [storedRequest('draft', schemaText)])
  const locations = [backup => backup.data.requests[0], backup => backup.drafts[0], backup => backup.data.history[0].request, backup => backup.data.trash.requests[0]]
  for (const locate of locations) for (const invalid of [null, false, 42, {}, []]) {
    const corrupted = structuredClone(original)
    locate(corrupted).responseSchema = invalid
    assert.throws(() => parseBackup(JSON.stringify(corrupted)), /responseSchema/)
  }
  assert.equal(parseBackup(JSON.stringify(original)).data.requests[0].responseSchema, schemaText)
})

test('Postman collection round trips retain schemas across folders and preserve active validation behavior', () => {
  const collection = { id: 'c', name: 'API', folders: ['Users/Details'] }
  const modern = schema({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: { id: { type: 'integer' } }, type: 'object', required: ['id'], properties: { id: { $ref: '#/$defs/id' } }, unevaluatedProperties: false })
  const requests = [storedRequest('draft7', schemaText), storedRequest('modern', modern, { folder: 'Users/Details' }), storedRequest('blank', ''), storedRequest('legacy')]
  const exported = exportCollection(collection, requests)
  assert.equal(exported.item.find(item => item.name === 'Request draft7').reqdesk.responseSchema, schemaText)
  const parsed = importPostman(JSON.stringify(exported))
  assert.equal(parsed.skipped, 0)
  const imported = name => parsed.requests.find(request => request.name === name)
  assert.equal(imported('Request draft7').responseSchema, schemaText)
  assert.equal(imported('Request modern').responseSchema, modern)
  assert.equal(imported('Request modern').folder, 'Users/Details')
  assert.equal(imported('Request blank').responseSchema, '')
  assert.equal(Object.hasOwn(imported('Request legacy'), 'responseSchema'), false)
  for (const request of [imported('Request draft7'), imported('Request modern')]) {
    assert.equal(request.collectionId, parsed.collection.id)
    assert.ok(validateResponseSchema(request.responseSchema, response('{"id":7}')).every(result => result.passed))
    assert.ok(validateResponseSchema(request.responseSchema, response('{"id":"7"}')).some(result => !result.passed))
  }
})

test('ordinary Postman collections and malformed optional schema metadata remain importable without enabling schema checks', () => {
  const base = { info: { name: 'External', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'External request', request: { method: 'GET', url: 'https://example.test/' } }] }
  assert.equal(importPostman(JSON.stringify(base)).requests[0].responseSchema, undefined)
  for (const value of [null, true, 5, { type: 'object' }, []]) {
    const exported = structuredClone(base)
    exported.item[0].reqdesk = { responseSchema: value }
    const imported = importPostman(JSON.stringify(exported))
    assert.equal(imported.requests.length, 1)
    assert.equal(imported.skipped, 0)
    assert.deepEqual(validateResponseSchema(imported.requests[0].responseSchema, response('not JSON')), [])
  }
})

test('request normalization, workspace persistence and draft persistence preserve schemas while duplicated edits stay independent', () => {
  const previousStorage = globalThis.localStorage
  const entries = new Map()
  globalThis.localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) }
  try {
    const original = storedRequest('original', schemaText)
    const originalText = JSON.stringify(original)
    const normalized = normalizeRequestQuery(structuredClone(original))
    assert.equal(normalized.responseSchema, schemaText)
    assert.equal(normalized.params[0].key, 'q')
    const copy = normalizeRequestQuery({ ...structuredClone(normalized), id: 'copy', name: 'Copied request' })
    copy.responseSchema = schemaText.replace('"integer"', '"string"')
    const workspace = schemaWorkspace(); workspace.requests = [normalized, copy]
    writeWorkspace(workspace)
    write('tabs', [{ request: copy }])
    const loaded = read('requests', [])
    assert.equal(loaded[0].responseSchema, schemaText)
    assert.equal(loaded[1].responseSchema, schemaText.replace('"integer"', '"string"'))
    assert.equal(read('tabs', [])[0].request.responseSchema, copy.responseSchema)
    loaded[0].responseSchema = 'local edited text'
    assert.equal(read('requests', [])[0].responseSchema, schemaText)
    assert.equal(JSON.stringify(original), originalText)
  } finally { if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage }
})
