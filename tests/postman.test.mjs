import test from 'node:test'
import assert from 'node:assert/strict'
import { importPostman } from '../src/services/postmanImport.ts'
import { prepareRequest } from '../src/services/prepareRequest.ts'
const row = (key, value, enabled = true) => ({ id: crypto.randomUUID(), key, value, enabled })
const collection = (item, extra = {}) => JSON.stringify({ info: { name: 'Imported API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item, ...extra })

test('nested folders, collection variables, disabled query and headers survive import', () => {
  const imported = importPostman(collection([{ name: 'Users', item: [{ name: 'Get user', request: {
    method: 'GET', url: { raw: '{{baseUrl}}/users/:userId?limit=100&debug=true', query: [{ key: 'limit', value: '10' }, { key: 'debug', value: 'true', disabled: true }], variable: [{ key: 'userId', value: '42' }] },
    header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Debug', value: '{{missing}}', disabled: true }],
  } }] }], { variable: [{ key: 'baseUrl', value: 'https://example.test' }] }))
  assert.equal(imported.requests[0].name, 'Get user')
  assert.equal(imported.requests[0].folder, 'Users')
  assert.deepEqual(imported.collection.folders, ['Users'])
  assert.equal(imported.requests[0].headers[1].enabled, false)
  const prepared = prepareRequest(imported.requests[0], imported.collection.variables)
  assert.equal(prepared.url, 'https://example.test/users/42?limit=10')
  assert.deepEqual(prepared.headers, { accept: 'application/json' })
})

test('raw URL query repeats are imported once with decoded values', () => {
  const result = importPostman(collection([{ name: 'Search', request: { method: 'GET', url: 'https://example.test/?tag=a&tag=b&q=a%26b' } }]))
  const prepared = prepareRequest(result.requests[0])
  assert.equal(prepared.url, 'https://example.test/?tag=a&tag=b&q=a%26b')
  assert.equal(result.requests[0].params.length, 3)
})

test('auth inheritance and request noauth override are respected', () => {
  const result = importPostman(collection([{ name: 'Secure', auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] }, item: [
    { name: 'Private', request: { method: 'GET', url: 'https://example.test/private' } },
    { name: 'Public', request: { method: 'GET', url: 'https://example.test/public', auth: { type: 'noauth' } } },
  ] }], { variable: [{ key: 'token', value: 'abc' }] }))
  assert.equal(prepareRequest(result.requests[0], result.collection.variables).headers.authorization, 'Bearer abc')
  assert.equal(prepareRequest(result.requests[1], result.collection.variables).headers.authorization, undefined)
})

test('Basic Auth and templated JSON body are resolved before sending without altering saved templates', () => {
  const result = importPostman(collection([{ name: 'Create', request: { method: 'POST', url: '{{baseUrl}}/users', auth: { type: 'basic', basic: [{ key: 'username', value: '{{user}}' }, { key: 'password', value: '{{password}}' }] }, body: { mode: 'raw', raw: '{"name":"{{user}}"}', options: { raw: { language: 'json' } } } } }], { variable: [{ key: 'baseUrl', value: 'https://example.test' }, { key: 'user', value: 'alex' }, { key: 'password', value: 'secret' }] }))
  const before = JSON.stringify(result)
  const prepared = prepareRequest(result.requests[0], result.collection.variables)
  assert.equal(prepared.headers.authorization, 'Basic YWxleDpzZWNyZXQ=')
  assert.equal(prepared.headers['content-type'], 'application/json')
  assert.equal(prepared.body, '{"name":"alex"}')
  assert.equal(JSON.stringify(result), before)
})

test('API key query and headers are imported with correct destination', () => {
  const auth = destination => ({ type: 'apikey', apikey: [{ key: 'key', value: 'api-key' }, { key: 'value', value: '{{token}}' }, { key: 'in', value: destination }] })
  const result = importPostman(collection(['query', 'header'].map(destination => ({ name: destination, request: { method: 'GET', url: 'https://example.test/', auth: auth(destination) } })), { variable: [{ key: 'token', value: 'a&b' }] }))
  assert.equal(prepareRequest(result.requests[0], result.collection.variables).url, 'https://example.test/?api-key=a%26b')
  assert.equal(prepareRequest(result.requests[1], result.collection.variables).headers['api-key'], 'a&b')
})

test('unsupported bodies and auth are skipped with warnings; scripts are never run', () => {
  const result = importPostman(collection([
    { name: 'File', request: { method: 'POST', url: 'https://example.test', body: { mode: 'unknown', formdata: [] } } },
    { name: 'OAuth', request: { method: 'GET', url: 'https://example.test', auth: { type: 'oauth1' } } },
    { name: 'Safe', event: [{ listen: 'prerequest', script: { exec: ['throw new Error("never run")'] } }], request: { method: 'GET', url: 'https://example.test' } },
  ]))
  assert.equal(result.requests.length, 1)
  assert.equal(result.skipped, 2)
  assert.equal(result.warnings.length, 3)
})

test('malformed JSON, wrong exports and v1 collections do not import', () => {
  for (const text of ['{', '{}', '{"values":[]}', '{"info":{"name":"v1","schema":"v1"},"item":[]}']) assert.throws(() => importPostman(text))
})

test('request variable overrides collection value; unknown and cyclic variables fail clearly', () => {
  const imported = importPostman(collection([{ name: 'GET', request: { method: 'GET', url: '{{baseUrl}}/users' } }])).requests[0]
  imported.variables = [row('baseUrl', 'https://request.test')]
  assert.equal(prepareRequest(imported, [row('baseUrl', 'https://collection.test')]).url, 'https://request.test/users')
  imported.variables = []
  assert.throws(() => prepareRequest(imported), /baseUrl.*has no value/)
  assert.throws(() => prepareRequest(imported, [row('baseUrl', '{{other}}'), row('other', '{{baseUrl}}')]), /Circular variable/)
})

test('HEAD/OPTIONS, disabled body, v2.0 and structured URLs are accepted', () => {
  const result = importPostman(JSON.stringify({ info: { name: 'v2', schema: 'https://schema.getpostman.com/json/collection/v2.0.0/collection.json' }, item: [
    { name: 'HEAD', request: { method: 'HEAD', url: { protocol: 'https', host: ['api', 'example', 'test'], port: '8443', path: ['v1', 'users'] }, body: { mode: 'raw', raw: '{{undefined}}' } } },
    { name: 'OPTIONS', request: { method: 'OPTIONS', url: 'https://example.test', body: { mode: 'file', disabled: true } } },
  ] }))
  assert.equal(prepareRequest(result.requests[0]).url, 'https://api.example.test:8443/v1/users')
  assert.equal(prepareRequest(result.requests[0]).body, undefined)
  assert.equal(result.requests[1].bodyType, 'none')
  assert.equal(result.skipped, 0)
})

test('independent imports have distinct collection, request and pair IDs', () => {
  const text = collection([{ name: 'GET', request: { method: 'GET', url: 'https://example.test/?page=1' } }])
  const first = importPostman(text), second = importPostman(text)
  assert.notEqual(first.collection.id, second.collection.id)
  assert.notEqual(first.requests[0].id, second.requests[0].id)
  assert.notEqual(first.requests[0].params[0].id, second.requests[0].params[0].id)
})
