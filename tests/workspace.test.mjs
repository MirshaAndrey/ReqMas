import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareRequest } from '../src/services/prepareRequest.ts'
import { captureCookies, cookiesFor, checkResponse, exportCollection, importEnvironment, exportEnvironment } from '../src/services/workspace.ts'
import { importPostman } from '../src/services/postmanImport.ts'
const p = (key, value, enabled = true) => ({ id: crypto.randomUUID(), key, value, enabled })
const request = (extra = {}) => ({ id: 'r', collectionId: 'c', name: 'Test', method: 'POST', url: '{{base}}/echo', headers: [], params: [], bodyType: 'none', body: '', ...extra })
test('environment overrides collection in all request fields; request overrides environment', () => {
  const r = request({ variables: [p('value', 'request')], params: [p('q', '{{value}}')], headers: [p('X-Value', '{{value}}')], bodyType: 'json', body: '{"v":"{{value}}"}', basicAuth: { username: '{{value}}', password: '{{secret}}' } })
  const before = JSON.stringify(r)
  const out = prepareRequest(r, [p('base', 'https://old.test'), p('value', 'collection')], [p('base', 'https://env.test'), p('value', 'env'), p('secret', 's')])
  assert.equal(out.url, 'https://env.test/echo?q=request'); assert.equal(out.headers['x-value'], 'request'); assert.equal(out.headers.authorization, 'Basic cmVxdWVzdDpz'); assert.equal(out.body, '{"v":"request"}'); assert.equal(JSON.stringify(r), before)
  assert.equal(prepareRequest(request(), [p('base', 'https://fallback.test')], [p('base', 'https://disabled.test', false)]).url, 'https://fallback.test/echo')
})
test('URL encoded data preserves repeated keys and escaping, and GET ignores body variables', () => {
  const r = request({ url: 'https://example.test', bodyType: 'urlencoded', form: [p('tag', 'a&b'), p('tag', '{{v}}'), p('skip', '{{missing}}', false)] })
  const out = prepareRequest(r, [], [p('v', 'a b')]); assert.equal(out.body, 'tag=a%26b&tag=a+b'); assert.equal(out.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(prepareRequest({ ...r, method: 'GET' }).body, undefined)
})
test('multipart and binary preserve arbitrary file bytes and use a matching boundary', () => {
  const bytes = Buffer.from([0, 255, 13, 10, 128]); const out = prepareRequest(request({ url: 'https://example.test', bodyType: 'formdata', form: [p('field', 'hello')], files: [{ id: 'f', key: 'upload', name: 'test.bin', type: 'application/octet-stream', enabled: true, base64: bytes.toString('base64') }] }))
  const wire = Buffer.from(out.bodyBase64, 'base64'); const boundary = out.headers['content-type'].split('boundary=')[1]
  assert.ok(wire.includes(bytes)); assert.ok(wire.includes(Buffer.from('name="field"\r\n\r\nhello'))); assert.ok(wire.includes(Buffer.from(`--${boundary}--\r\n`)))
  const binary = prepareRequest(request({ url: 'https://example.test', bodyType: 'binary', binary: { name: 'b', type: '', base64: bytes.toString('base64') } })); assert.deepEqual(Buffer.from(binary.bodyBase64, 'base64'), bytes)
  assert.throws(() => prepareRequest(request({ url: 'https://example.test', bodyType: 'binary' })), /Choose a binary file/)
})
test('assertions handle status, timing, JSON paths, headers, missing paths and invalid JSON', () => {
  const response = { status: 201, duration: 12, headers: { 'content-type': 'application/json' }, body: '{"users":[{"id":1}],"ok":true}' }
  const rules = [['status', '', '201'], ['duration', '', '20'], ['json', 'users.0.id', '1'], ['header', 'Content-Type', 'application/json'], ['contains', '', 'true'], ['json', 'missing', 'undefined']].map(([kind, key, expected]) => ({ id: crypto.randomUUID(), kind, key, expected, enabled: true }))
  assert.deepEqual(checkResponse(rules, response).map(t => t.passed), [true, true, true, true, true, false]); assert.equal(checkResponse([rules[2]], { ...response, body: 'oops' })[0].passed, false)
  assert.deepEqual(checkResponse([{ ...rules[0], enabled: false }], response), [])
})
test('cookies obey domain boundaries, HTTPS, paths, expiry, overwrite and deletion', () => {
  let jar = captureCookies('https://api.example.test/users/login', ['sid=abc; Path=/users; Secure; Max-Age=60', 'host=x; Path=/', 'bad=x; Domain=evil.test'], [], 1000)
  assert.equal(jar.length, 2); assert.equal(cookiesFor('https://api.example.test/users/1', jar, 2000), 'sid=abc; host=x')
  assert.equal(cookiesFor('http://api.example.test/users/1', jar, 2000), 'host=x'); assert.equal(cookiesFor('https://api.example.test/usersXYZ', jar, 2000), 'host=x'); assert.equal(cookiesFor('https://evilapi.example.test/users', jar, 2000), '')
  assert.equal(cookiesFor('https://api.example.test/users/1', jar, 62000), 'host=x')
  jar = captureCookies('https://api.example.test/', ['host=y; Path=/', 'sid=; Path=/users; Max-Age=0'], jar, 2000); assert.equal(jar.length, 1); assert.equal(jar[0].value, 'y')
})
test('environment import/export preserves disabled and empty values with fresh IDs', () => {
  const env = importEnvironment('{"name":"Dev","values":[{"key":"base","value":"https://example.test","enabled":true},{"key":"empty","value":"","enabled":false}]}')
  const copy = importEnvironment(JSON.stringify(exportEnvironment(env))); assert.deepEqual(copy.variables.map(({ key, value, enabled }) => ({ key, value, enabled })), env.variables.map(({ key, value, enabled }) => ({ key, value, enabled }))); assert.notEqual(copy.id, env.id)
  assert.throws(() => importEnvironment('{"info":{},"item":[]}'))
})
test('collection round trip preserves nested folders, new bodies, bytes, variables and assertions', () => {
  const tests = [{ id: 't', kind: 'status', key: '', expected: '200', enabled: true }]
  const requests = [request({ folder: 'Users/Admin', tests, bodyType: 'urlencoded', form: [p('a', '{{value}}')] }), request({ id: 'b', folder: 'Files', bodyType: 'binary', binary: { name: 'x.bin', type: '', base64: 'AP8=' } })]
  const out = importPostman(JSON.stringify(exportCollection({ id: 'c', name: 'API', variables: [p('base', 'https://api.test')], folders: ['Empty'] }, requests)))
  assert.equal(out.requests.length, 2); assert.equal(out.requests[0].folder, 'Users/Admin'); assert.equal(out.requests[0].form[0].value, '{{value}}'); assert.equal(out.requests[0].tests[0].expected, '200'); assert.equal(out.requests[1].binary.base64, 'AP8='); assert.ok(out.collection.folders.includes('Empty'))
})
test('OAuth uses templated Bearer token and rejects missing or expired token', () => {
  const oauth = { tokenUrl: '', clientId: '', clientSecret: '', scope: '', accessToken: '{{token}}' }
  assert.equal(prepareRequest(request({ oauth }), [p('base', 'https://api.test')], [p('token', 'abc')]).headers.authorization, 'Bearer abc')
  assert.throws(() => prepareRequest(request({ url: 'https://api.test', oauth: { ...oauth, accessToken: '' } })), /Get an OAuth/)
  assert.throws(() => prepareRequest(request({ url: 'https://api.test', oauth: { ...oauth, expiresAt: 1 } })), /expired/)
})
