import test from 'node:test'
import assert from 'node:assert/strict'
import { importCurl, curlTokens, exportCurl } from '../src/services/curl.ts'
import { importOpenApi } from '../src/services/openApiImport.ts'
import { importPostman, POSTMAN_IMPORT_MAX_BYTES, POSTMAN_IMPORT_MAX_ITEMS, POSTMAN_IMPORT_MAX_DEPTH } from '../src/services/postmanImport.ts'
import { exportCollection, exportEnvironment, importEnvironment, POSTMAN_ENVIRONMENT_MAX_BYTES, POSTMAN_ENVIRONMENT_MAX_VARIABLES } from '../src/services/workspace.ts'
import { prepareRequest } from '../src/services/prepareRequest.ts'
import { Validator } from '@cfworker/json-schema'
import { createExportBackup, MAX_BACKUP_BYTES } from '../src/services/backup.ts'
const oas = extra => JSON.stringify({ openapi: '3.1.0', info: { title: 'Audit', version: '1.0' }, servers: [{ url: 'https://example.test' }], paths: {}, ...extra })
const postman = item => JSON.stringify({ info: { name: 'Audit' }, item })

test('cURL GET appends data after existing repeated query parameters without overwriting', () => {
  const request = importCurl("curl -G --data 'tag=c' 'https://example.test/?tag=a&tag=b'", 'c')
  assert.equal(prepareRequest(request).url, 'https://example.test/?tag=a&tag=b&tag=c')
  assert.equal(request.url, 'https://example.test/?tag=a&tag=b&tag=c')
})
test('repeated cURL JSON fragments concatenate without form separators', () => {
  const request = importCurl(`curl --json '{"name":' --json '"Alice"}' https://example.test`, 'c')
  assert.equal(prepareRequest(request).body, '{"name":"Alice"}')
})
test('cURL quoting preserves literal line continuations inside single quotes', () => {
  assert.deepEqual(curlTokens("curl --data-raw 'before\\\nafter' https://example.test"), ['curl', '--data-raw', 'before\\\nafter', 'https://example.test'])
  assert.deepEqual(curlTokens('curl --data-raw "before\\\nafter" https://example.test'), ['curl', '--data-raw', 'beforeafter', 'https://example.test'])
  const original = { id: 'r', collectionId: 'c', name: 'Multiline', method: 'POST', url: 'https://example.test', headers: [], params: [], bodyType: 'text', body: 'before\\\nafter' }
  assert.equal(prepareRequest(importCurl(exportCurl(original), 'c')).body, original.body)
})
test('cURL URL encoding preserves an already encoded name', () => {
  const request = importCurl("curl --data-urlencode 'filter%5Bname%5D=Alice Smith' https://example.test", 'c')
  assert.equal(prepareRequest(request).body, 'filter%5Bname%5D=Alice%20Smith')
})
test('cURL refuses combinations that would silently discard an unsupported GET or HEAD body', () => {
  for (const command of ["curl -X GET -d 'a=1' https://example.test", "curl -I -d 'a=1' https://example.test", "curl -G -F 'a=1' https://example.test"]) assert.throws(() => importCurl(command, 'c'), /body|form|HEAD/i)
})
test('cURL export uses --head and preserves normal POST redirect semantics', () => {
  const request = { id: 'r', collectionId: 'c', name: 'HEAD', method: 'HEAD', url: 'https://example.test', headers: [], params: [], bodyType: 'none', body: '' }
  const head = exportCurl(request)
  assert.match(head, /--head/); assert.doesNotMatch(head, /--request HEAD/)
  assert.equal(importCurl(head, 'c').method, 'HEAD')
  const post = exportCurl({ ...request, method: 'POST', bodyType: 'json', body: '{"ok":true}' })
  assert.doesNotMatch(post, /--request POST/)
  assert.equal(importCurl(post, 'c').method, 'POST')
})
test('cURL import respects the last Content-Type header when selecting the body editor', () => {
  const request = importCurl(`curl -H 'Content-Type: application/json' -H 'Content-Type: text/plain' -d 'plain text' https://example.test`, 'c')
  assert.equal(prepareRequest(request).body, 'plain text')
  assert.equal(prepareRequest(request).headers['content-type'], 'text/plain')
})
test('an empty multipart cURL export preserves the boundary-only body and POST method', () => {
  const request = { id: 'r', collectionId: 'c', name: 'Empty form', method: 'POST', url: 'https://example.test', headers: [], params: [], bodyType: 'formdata', body: '', form: [], files: [] }
  const restored = prepareRequest(importCurl(exportCurl(request), 'c'))
  assert.equal(restored.method, 'POST')
  const boundary = restored.headers['content-type'].split('boundary=')[1]
  assert.equal(restored.body, `--${boundary}--\r\n`)
})
test('OpenAPI explicit form examples preserve optional fields, example-only fields and repeated arrays', () => {
  const result = importOpenApi(oas({ paths: { '/form': { post: { requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } }, example: { name: 'Alice', tags: ['one', 'two'], extra: 'included' } } } }, responses: {} } } } }))
  assert.equal(prepareRequest(result.requests[0]).body, 'name=Alice&tags=one&tags=two&extra=included')
})
test('OpenAPI form schemas retain allOf fields and enable required fields', () => {
  const result = importOpenApi(oas({ components: { schemas: { Base: { type: 'object', properties: { name: { type: 'string', default: 'Alice' } } } } }, paths: { '/form': { post: { requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', required: ['active'], properties: { active: { type: 'boolean' } } }] } } } }, responses: {} } } } }))
  assert.equal(prepareRequest(result.requests[0]).body, 'name=Alice&active=false')
})
test('OpenAPI response schemas do not require request-only writeOnly fields', () => {
  const result = importOpenApi(oas({ paths: { '/user': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', required: ['name', 'password'], properties: { name: { type: 'string' }, password: { type: 'string', writeOnly: true } } } } } } } } } } }))
  const schema = JSON.parse(result.requests[0].responseSchema)
  assert.equal(new Validator(schema, '2020-12', false).validate({ name: 'Alice' }).valid, true)
})
test('Postman embedded malformed attachment bytes are not accepted as a usable file', () => {
  const result = importPostman(postman([{ name: 'Bad file', request: { method: 'POST', url: 'https://example.test', body: { mode: 'file' } }, reqdesk: { binary: { name: 'bad.bin', type: 'application/octet-stream', base64: 'A' } } }]))
  assert.equal(result.requests[0].binary, undefined)
  assert.ok(result.warnings.some(w => /invalid.*base64/i.test(w)))
})
test('Postman request-local files and auth survive collection export/import', () => {
  const c = { id: 'c', name: 'Roundtrip', authMode: 'bearer', bearerToken: 'collection' }
  const requests = ['none', 'inherit', 'basic', 'bearer', 'apikey', 'oauth'].map((authMode, i) => ({ id: String(i), collectionId: 'c', name: authMode, method: 'POST', url: 'https://example.test', headers: [], params: [], bodyType: 'binary', body: '', binary: { name: 'data.bin', type: 'application/octet-stream', base64: 'AAECAw==' }, authMode, basicAuth: { username: 'u', password: 'p' }, bearerToken: 'local', apiKey: { key: 'X-Key', value: 'key', in: 'header' }, oauth: { tokenUrl: 'https://example.test/token', clientId: 'client', clientSecret: 'secret', scope: '', accessToken: 'token', clientAuth: 'basic', expiresAt: 12345 } }))
  const result = importPostman(JSON.stringify(exportCollection(c, requests, { includeSecrets: true })))
  assert.deepEqual(result.requests.map(r => r.authMode), requests.map(r => r.authMode))
  assert.ok(result.requests.every(r => r.binary.base64 === 'AAECAw=='))
  assert.ok(!result.warnings.some(w => /attach/i.test(w)))
  assert.equal(result.requests[5].oauth.clientAuth, 'basic'); assert.equal(result.requests[5].oauth.expiresAt, 12345)
})
test('one malformed Postman header skips that request while preserving valid collection requests', () => {
  const result = importPostman(postman([{ name: 'Bad header', request: { method: 'GET', url: 'https://example.test', header: 'missing colon' } }, { name: 'Valid', request: { method: 'GET', url: 'https://example.test', header: 'Accept: application/json' } }]))
  assert.equal(result.skipped, 1); assert.equal(result.requests.length, 1)
  assert.equal(result.requests[0].name, 'Valid'); assert.ok(result.warnings.some(w => /Malformed header/.test(w)))
})
test('Postman depth is bounded before traversal and valid folders deeper than 50 still import', () => {
  const nested = depth => {
    let items = [{ name: 'Leaf', request: { method: 'GET', url: 'https://example.test' } }]
    for (let i = 0; i < depth; i++) items = [{ name: `Folder ${i}`, item: items }]
    return postman(items)
  }
  const result = importPostman(nested(POSTMAN_IMPORT_MAX_DEPTH))
  assert.equal(result.requests.length, 1); assert.equal(result.collection.folders.length, 100)
  assert.throws(() => importPostman(nested(POSTMAN_IMPORT_MAX_DEPTH + 1)), /maximum is 100 folder levels/)
})
test('Postman collections reject oversized bytes and too many items before import', () => {
  assert.throws(() => importPostman(' '.repeat(POSTMAN_IMPORT_MAX_BYTES + 1)), /50 MiB/)
  assert.throws(() => importPostman(postman(Array.from({ length: POSTMAN_IMPORT_MAX_ITEMS + 1 }, () => ({ name: 'Empty', item: [] })))), /10,000 requests and folders/)
})
test('environment import has bounded input and validates variable records without lossy coercion', () => {
  assert.throws(() => importEnvironment(' '.repeat(POSTMAN_ENVIRONMENT_MAX_BYTES + 1)), /1 MiB/)
  assert.throws(() => importEnvironment(JSON.stringify({ name: 'Dev', values: Array.from({ length: POSTMAN_ENVIRONMENT_MAX_VARIABLES + 1 }, () => ({ key: '', value: '' })) })), /10,000/)
  for (const entry of [null, [], { key: 1 }, { key: 'nested', value: { token: 'secret' } }, { key: 'array', value: [] }, { key: 'flag', enabled: 'false' }]) assert.throws(() => importEnvironment(JSON.stringify({ name: 'Dev', values: [entry] })), /Environment variable 1/)
  const imported = importEnvironment(JSON.stringify({ name: 'Dev', values: [{ key: 'number', value: 42 }, { key: 'boolean', value: false }, { key: 'null', value: null, enabled: false }] }))
  assert.deepEqual(imported.variables.map(v => [v.key, v.value, v.enabled]), [['number', '42', true], ['boolean', 'false', true], ['null', '', false]])
})

test('Postman cannot introduce lists that desktop startup and backup restore reject', () => {
  const rows = Array.from({ length: 10001 }, (_, i) => ({ key: `field${i}`, value: 'x' }))
  const source = { info: { name: 'Limits' }, item: [{ name: 'GET', request: { method: 'GET', url: 'https://example.test' } }] }
  for (const mutate of [
    s => s.variable = rows,
    s => s.item[0].variable = rows,
    s => s.item[0].request.header = rows,
    s => s.item[0].request.header = rows.map(p => `${p.key}: ${p.value}`).join('\n'),
    s => s.item[0].request.url = { raw: 'https://example.test', query: rows },
    s => s.item[0].request.url = `https://example.test/?${rows.map(p => `${p.key}=x`).join('&')}`,
    s => s.item[0].request.body = { mode: 'urlencoded', urlencoded: rows },
    s => { s.item = [{ name: 'Folder', variable: rows.slice(0, 6000), item: [{ ...s.item[0], variable: rows.slice(6000).concat([{ key: 'extra', value: 'x' }]) }] }] },
  ]) {
    const input = structuredClone(source); mutate(input)
    assert.throws(() => importPostman(JSON.stringify(input)), /maximum 10,000 entries/)
  }
  const valid = structuredClone(source); valid.variable = rows.slice(0, 10000)
  assert.equal(importPostman(JSON.stringify(valid)).collection.variables.length, 10000)
})

test('Postman embedded attachments obey the same size limit as workspace restoration', () => {
  const input = postman([{ name: 'Large file', request: { method: 'POST', url: 'https://example.test', body: { mode: 'file' } }, reqdesk: { binary: { name: 'large.bin', type: 'application/octet-stream', base64: 'A'.repeat(14 * 1024 * 1024 + 4) } } }])
  assert.throws(() => importPostman(input), /base64/)
})

test('OpenAPI cannot expand one array example beyond the stored form-row limit', () => {
  const input = oas({ paths: { '/form': { post: { requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object' }, example: { tags: Array(10001).fill('x') } } } }, responses: {} } } } })
  assert.throws(() => importOpenApi(input), /maximum 10,000 entries/)
})

test('OpenAPI expansion is bounded before shared body examples fill the workspace', () => {
  const paths = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`/large${i}`, { post: { requestBody: { $ref: '#/components/requestBodies/Large' }, responses: {} } }]))
  const input = oas({ paths, components: { requestBodies: { Large: { content: { 'text/plain': { example: 'x'.repeat(1024 * 1024) } } } } } })
  assert.throws(() => importOpenApi(input), /50 MiB workspace limit/)
})

test('backup exports check the formatted JSON limit used by download and preview', () => {
  const request = { id: 'r', collectionId: 'c', name: 'Large', method: 'POST', url: 'https://example.test', headers: [], params: [], bodyType: 'text', body: '' }
  const data = { collections: [{ id: 'c', name: 'API' }], requests: [request], environments: [], environmentId: '', cookies: [], history: [], trash: { requests: [], collections: [] } }
  request.headers = Array.from({ length: 10000 }, (_, i) => ({ id: `h${i}`, key: `X-${i}`, value: 'x', enabled: true }))
  request.body = 'x'.repeat(MAX_BACKUP_BYTES - JSON.stringify(data).length - 1024)
  assert.ok(new TextEncoder().encode(JSON.stringify(data)).length < MAX_BACKUP_BYTES)
  assert.throws(() => createExportBackup(data, 'system'), /backup exceeds 50 MB/)
})

test('Postman exports count folders and requests together and reject unreadable nesting', () => {
  const collection = { id: 'c', name: 'Large', folders: ['Folder'] }
  const requests = Array.from({ length: 10000 }, (_, i) => ({ id: `r${i}`, collectionId: 'c', name: `Request ${i}`, method: 'GET', url: 'https://example.test', headers: [], params: [], bodyType: 'none', body: '' }))
  assert.throws(() => exportCollection(collection, requests), /10,000 requests and folders/)
  const valid = exportCollection(collection, requests.slice(0, 9999))
  assert.equal(importPostman(JSON.stringify(valid)).requests.length, 9999)
  const deep = { ...collection, folders: [Array.from({ length: 101 }, (_, i) => `folder${i}`).join('/')] }
  assert.throws(() => exportCollection(deep, []), /100 folder levels/)
})

test('environment exports never produce a file larger than their importer accepts', () => {
  const env = { id: 'e', name: 'Large', variables: [{ id: 'v', key: 'body', value: 'x'.repeat(POSTMAN_ENVIRONMENT_MAX_BYTES), enabled: true }] }
  assert.throws(() => exportEnvironment(env), /1 MiB/)
  assert.throws(() => exportEnvironment({ ...env, variables: Array.from({ length: 10001 }, (_, i) => ({ id: String(i), key: 'v', value: '', enabled: true })) }), /10,000/)
})
