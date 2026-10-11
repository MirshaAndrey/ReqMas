import test from 'node:test'
import assert from 'node:assert/strict'
import { importCurl, exportCurl, curlTokens } from '../src/services/curl.ts'
import { captureVariables, responseValue, appendHistory } from '../src/services/responseData.ts'
import { prepareRequest } from '../src/services/prepareRequest.ts'
import { withCollectionAuth, requestTimeout } from '../src/services/requestOptions.ts'
import { formatJsonTemplate } from '../src/services/jsonEditor.ts'
import { createBackup, parseBackup } from '../src/services/backup.ts'
import { writeWorkspace, read } from '../src/storage/database.ts'
import { exportCollection } from '../src/services/workspace.ts'
import { importPostman } from '../src/services/postmanImport.ts'
const p = (key, value, enabled = true) => ({ id: crypto.randomUUID(), key, value, enabled })
const req = (extra = {}) => ({ id: 'r', collectionId: 'c', name: 'Example', method: 'POST', url: 'https://example.test/echo', headers: [], params: [], bodyType: 'none', body: '', ...extra })
const res = (extra = {}) => ({ status: 200, statusText: 'OK', duration: 10, size: 40, body: '{"data":{"token":"abc","ids":[42]},"ok":true}', headers: { 'x-request-id': '42', 'content-type': 'application/json' }, ...extra })
const rule = (path, variable = 'token', source = 'json') => ({ id: crypto.randomUUID(), source, path, variable, enabled: true })
const env = { id: 'dev', name: 'Development', variables: [p('token', 'old', false)] }
const data = () => ({ collections: [{ id: 'c', name: 'API', authMode: 'apikey', apiKey: { key: 'X-Key', value: '{{token}}', in: 'header' } }], requests: [req({ bodyType: 'binary', binary: { name: 'data.bin', type: 'application/octet-stream', base64: 'AP8=' }, extractions: [rule('data.token')] })], environments: [env], environmentId: 'dev', cookies: [{ id: 'cookie', name: 'sid', value: 'secret', domain: 'example.test', path: '/', secure: true, hostOnly: true }], history: [{ id: 'history', request: req(), response: res(), status: 200, duration: 10, time: '2026-10-06T00:00:00Z' }], trash: { requests: [], collections: [] } })

test('cURL parses multiline quoting, headers, JSON, Basic Auth, cookies and timeouts', () => {
  const command = `curl --location 'https://example.test/a?q=one&tag=two' \\\n    -XPOST -H 'Content-Type: application/json' --data-raw '{"name":"O'\\''Brien","emoji":"😀"}' \\\n    -u 'alice:p:a' --cookie 'sid=value' -m2.5`
  const r = importCurl(command, 'c'); const out = prepareRequest(r)
  assert.equal(r.method, 'POST'); assert.equal(r.followRedirects, true); assert.equal(r.timeoutMs, 2500)
  assert.equal(JSON.parse(out.body).name, "O'Brien"); assert.equal(JSON.parse(out.body).emoji, '😀')
  assert.equal(out.headers.authorization, 'Basic YWxpY2U6cDph'); assert.equal(out.headers.cookie, 'sid=value')
  assert.equal(importCurl('curl https://example.test', 'c').followRedirects, false)
  assert.deepEqual(curlTokens(`curl $'hello\\nworld'`), ['curl', 'hello\nworld'])
})
test('cURL preserves form encoding, repeated query values, JSON defaults and safe text form fields', () => {
  const r = importCurl(`curl --data 'a=1' --data 'a=2' https://example.test`, 'c')
  assert.equal(prepareRequest(r).body, 'a=1&a=2'); assert.equal(prepareRequest(r).headers['content-type'], 'application/x-www-form-urlencoded')
  const q = importCurl(`curl -G --data-urlencode 'q=a&b' --data 'tag=a&tag=b' https://example.test`, 'c')
  assert.equal(prepareRequest(q).url, 'https://example.test/?q=a%26b&tag=a&tag=b'); assert.equal(q.bodyType, 'none')
  const j = prepareRequest(importCurl(`curl --json '{"id":1}' https://example.test`, 'c'))
  assert.equal(j.headers.accept, 'application/json'); assert.equal(j.headers['content-type'], 'application/json')
  assert.equal(importCurl(`curl --form-string 'key=@literal' https://example.test`, 'c').form[0].value, '@literal')
})
test('cURL refuses unknown options, file reads, shell operators and incomplete commands', () => {
  for (const command of ['curl -k https://example.test', 'curl --data @private.txt https://example.test', "curl -F 'file=@private.txt' https://example.test", 'curl https://example.test; echo secret', 'curl $(cat private.txt)', "curl 'unclosed", 'wget https://example.test', 'curl --max-time 0 https://example.test']) assert.throws(() => importCurl(command, 'c'), undefined, command)
})
test('cURL export resolves templates and auth and can be imported with equivalent wire data', () => {
  const r = req({ bodyType: 'json', body: '{"name":"{{name}}"}', params: [p('tag', 'one'), p('tag', 'two')], headers: [p('X-Example', "O'Brien")], bearerToken: '{{token}}', timeoutMs: 1500 })
  const variables = [p('name', "O'Brien"), p('token', 'abc')]
  const command = exportCurl(r, [], variables); const imported = importCurl(command, 'c')
  assert.deepEqual(prepareRequest(imported), prepareRequest(r, [], variables)); assert.equal(imported.timeoutMs, 1500)
})
test('capture reads arrays, scalar values, objects and case-insensitive headers without prototype traversal', () => {
  assert.equal(responseValue(res(), 'json', '$.data.ids.0'), '42')
  assert.equal(responseValue(res(), 'json', 'ok'), 'true')
  assert.equal(responseValue(res(), 'header', 'X-Request-ID'), '42')
  assert.deepEqual(JSON.parse(responseValue(res(), 'json', 'data')), { token: 'abc', ids: [42] })
  assert.throws(() => responseValue(res(), 'json', '__proto__.constructor'))
})
test('capture updates the environment only if every enabled rule succeeds on a 2xx response', () => {
  const before = JSON.stringify(env)
  const out = captureVariables([rule('data.token'), rule('X-Request-ID', 'requestId', 'header')], res(), env)
  assert.deepEqual(out.variables.map(v => [v.key, v.value, v.enabled]), [['token', 'abc', true], ['requestId', '42', true]])
  assert.ok(out.results.every(r => r.passed)); assert.equal(JSON.stringify(env), before)
  for (const [rules, response, environment] of [[[rule('data.token'), rule('missing')], res(), env], [[rule('data.token')], res({ status: 401 }), env], [[rule('data.token')], res(), undefined]]) { const out = captureVariables(rules, response, environment); assert.equal(out.variables, undefined); assert.ok(out.results.every(r => !r.passed)) }
  assert.deepEqual(captureVariables([{ ...rule('missing'), enabled: false }], res(), env), { results: [] })
})
test('collection auth inherits, explicit none overrides, and API key destinations resolve variables', () => {
  const c = { id: 'c', name: 'API', authMode: 'apikey', apiKey: { key: '{{key}}', value: '{{token}}', in: 'query' } }
  const variables = [p('key', 'api-key'), p('token', 'a&b')]
  assert.equal(prepareRequest(withCollectionAuth(req({ params: [p('api-key', 'old')] }), c), [], variables).url, 'https://example.test/echo?api-key=a%26b')
  assert.equal(prepareRequest(withCollectionAuth(req({ authMode: 'none' }), c), [], variables).url, 'https://example.test/echo')
  const local = withCollectionAuth(req({ authMode: 'bearer', bearerToken: 'local', basicAuth: { username: 'ignored', password: '' } }), c)
  assert.equal(prepareRequest(local).headers.authorization, 'Bearer local'); assert.equal(local.basicAuth, undefined)
  assert.equal(prepareRequest(withCollectionAuth(req(), { ...c, apiKey: { ...c.apiKey, in: 'header' } }), [], variables).headers['api-key'], 'a&b')
  assert.equal(requestTimeout(req()), 30000); assert.equal(requestTimeout(req({ timeoutMs: Infinity })), 30000); assert.equal(requestTimeout(req({ timeoutMs: 0 })), 100)
})
test('JSON formatting preserves quoted and unquoted variable templates and escaped text', () => {
  const input = '{"name":"{{name}}","id":{{id}},"escape":"a\\\"b\\\\c","nested":{"ok":true}}'
  const formatted = formatJsonTemplate(input)
  assert.ok(formatted.includes('"id": {{id}}')); assert.ok(formatted.includes('"name": "{{name}}"'))
  const wire = prepareRequest(req({ bodyType: 'json', body: formatted }), [], [p('name', 'Alex'), p('id', '42')]).body
  assert.deepEqual(JSON.parse(wire), { name: 'Alex', id: 42, escape: 'a"b\\c', nested: { ok: true } })
  assert.throws(() => formatJsonTemplate('{"a":1,}')); assert.throws(() => formatJsonTemplate('{"a":{{value}'))
})
test('workspace backup round trip includes secrets, attachments, history, drafts and theme', () => {
  const workspace = data(); const drafts = [req({ name: 'Unsaved', body: 'draft' })]
  const backup = createBackup(workspace, 'dark', drafts); const parsed = parseBackup(JSON.stringify(backup))
  assert.deepEqual(parsed, backup); assert.deepEqual(parsed.data, workspace); assert.deepEqual(parsed.drafts, drafts)
  workspace.requests[0].name = 'Changed'; assert.equal(backup.data.requests[0].name, 'Example')
})
test('backup validation rejects incompatible versions, broken references and malformed nested records before restoring', () => {
  const base = createBackup(data(), 'light')
  const mutations = [b => b.version = 2, b => b.data.requests.push(b.data.requests[0]), b => b.data.requests[0].collectionId = 'missing', b => b.data.environmentId = 'missing', b => b.data.requests[0].binary.base64 = '%bad', b => b.data.history[0].response.headers['x'] = 2, b => b.data.requests[0].timeoutMs = -1, b => b.drafts = [{}]]
  for (const mutate of mutations) { const b = structuredClone(base); mutate(b); assert.throws(() => parseBackup(JSON.stringify(b))) }
})
test('atomic storage keeps the previous workspace when quota failure rejects restoration', () => {
  const values = new Map([['reqdesk.requests', JSON.stringify([req({ name: 'Legacy' })])]])
  let reject = false; let writes = 0
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes++; if (reject) throw new Error('QuotaExceededError'); values.set(key, value) } }
  assert.equal(read('requests', [])[0].name, 'Legacy')
  writeWorkspace(data()); assert.equal(writes, 1); assert.equal(read('requests', [])[0].name, 'Example')
  reject = true; const replacement = data(); replacement.requests[0].name = 'Replacement'; assert.throws(() => writeWorkspace(replacement)); assert.equal(read('requests', [])[0].name, 'Example')
  delete globalThis.localStorage
})
test('history snapshots retain status and size while bounding UTF-8 bodies and entry count', () => {
  const entry = { id: 'h', request: req(), response: res({ body: '😀'.repeat(40000) + 'tail', size: 160004 }), status: 200, duration: 10, time: '2026-10-06' }
  const history = appendHistory(entry, Array.from({ length: 120 }, (_, i) => ({ ...entry, id: String(i) })))
  assert.equal(history.length, 100); assert.equal(history[0].bodyTruncated, true); assert.equal(history[0].response.size, 160004)
  assert.ok(history.every(h => !h.response.body.includes('�')))
  assert.ok(history.reduce((bytes, h) => bytes + Buffer.byteLength(h.response.body), 0) <= 1024 * 1024)
})
test('Postman round trip preserves collection inheritance, API keys, settings and capture rules', () => {
  const workspace = data(); const r = req({ authMode: 'inherit', timeoutMs: 1500, followRedirects: false, extractions: [rule('data.token')] })
  const parsed = importPostman(JSON.stringify(exportCollection(workspace.collections[0], [r])))
  assert.equal(parsed.requests[0].authMode, 'inherit'); assert.equal(parsed.requests[0].timeoutMs, 1500); assert.equal(parsed.requests[0].followRedirects, false); assert.equal(parsed.requests[0].extractions[0].path, 'data.token')
  assert.equal(prepareRequest(withCollectionAuth(parsed.requests[0], parsed.collection), [], [p('token', 'new')]).headers['x-key'], 'new')
})
