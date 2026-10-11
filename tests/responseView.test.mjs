import test from 'node:test'
import assert from 'node:assert/strict'
import { responseBytes, responseFileName, responseImageSource, responseKind, responseHeader, parseResponseJson, diffResponses, flattenJsonTree, jsonPointer, formatResponseJson, stringifyResponseValue, valueSummary } from '../src/services/responseView.ts'

const response = (body, extra = {}) => ({ status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, duration: 10, size: Buffer.byteLength(body), body, ...extra })

test('response download preserves binary bytes and original text encoding rather than decoded display text', () => {
  const bytes = Uint8Array.of(0, 255, 128, 65, 13, 10)
  assert.deepEqual(responseBytes(response('display only', { binary: true, bodyBase64: Buffer.from(bytes).toString('base64') })), bytes)
  assert.deepEqual(responseBytes(response('incorrect display', { bodyBase64: '//4=' })), Uint8Array.of(255, 254))
  assert.deepEqual(responseBytes(response('Привет 😀')), new TextEncoder().encode('Привет 😀'))
  assert.deepEqual(responseBytes(response('', { binary: true, bodyBase64: '' })), new Uint8Array())
  assert.throws(() => responseBytes(response('partial', { bodyTruncated: true })), /incomplete/)
  assert.throws(() => responseBytes(response('', { binary: true })), /unavailable/)
  assert.throws(() => responseBytes(response('', { bodyBase64: 'not base64!' })), /valid base64/)
})
test('response filenames prefer RFC 5987 and sanitize server paths, reserved Windows names and controls', () => {
  const r = extra => response('{}', extra)
  assert.equal(responseFileName(r({ headers: { 'Content-Disposition': `attachment; filename="fallback.json"; filename*=UTF-8''%D0%BE%D1%82%D0%B2%D0%B5%D1%82.json` } })), 'ответ.json')
  assert.equal(responseFileName(r({ headers: { 'content-disposition': 'attachment; filename="../../private/result.json"' } })), 'result.json')
  assert.equal(responseFileName(r({ headers: { 'content-disposition': 'attachment; filename="CON.txt"' } })), '_CON.txt')
  assert.equal(responseFileName(r({ url: 'https://example.test/download/report%20data', headers: { 'content-type': 'text/csv' } })), 'report data.csv')
  assert.equal(responseFileName(r({ headers: { 'content-type': 'application/pdf' } })), 'response.pdf')
  assert.equal(responseFileName(r({ headers: { 'content-disposition': `attachment; filename="fallback.json"; filename*=UTF-8''%ZZ` } })), 'fallback.json')
  assert.equal(responseFileName(r({ headers: { 'content-disposition': 'attachment; filename="bad:name?.json..."' } })), 'bad_name_.json')
  assert.equal(responseFileName(r({ headers: { 'content-disposition': 'attachment; filename="C:\\private\\report.json"' } })), 'report.json')
  assert.equal(responseFileName(r({ headers: { 'content-disposition': `attachment; filename*=UTF-8''bad%00name.json` } })), 'bad_name.json')
  assert.ok(responseFileName(r({ url: 'https://example.test/' + 'a'.repeat(500) + '.json' })).length <= 180)
})
test('image preview accepts raster images and rejects active SVG, HTML and incomplete or oversized snapshots', () => {
  const img = type => response('', { binary: true, bodyBase64: 'AP8=', headers: { 'Content-Type': type } })
  assert.equal(responseImageSource(img('image/png; charset=binary')), 'data:image/png;base64,AP8=')
  assert.equal(responseImageSource(img('image/svg+xml')), undefined)
  assert.equal(responseImageSource(img('text/html')), undefined)
  assert.equal(responseImageSource({ ...img('image/png'), bodyTruncated: true }), undefined)
  assert.equal(responseImageSource({ ...img('image/png'), bodyBase64: 'A'.repeat(8 * 1024 * 1024 + 4) }), undefined)
  assert.equal(responseHeader(img('image/png'), 'CONTENT-TYPE'), 'image/png')
  assert.equal(responseKind(img('application/pdf')), 'PDF')
})
test('JSON comparison ignores object order and reports added, removed and changed values at escaped pointers', () => {
  const a = response('{"a/b":{"~key":1},"same":null,"removed":true,"array":[1,2]}')
  const b = response('{"array":[1,3,4],"same":null,"a/b":{"~key":2},"added":"yes"}')
  const result = diffResponses(a, b)
  assert.equal(result.kind, 'json'); assert.equal(result.truncated, false); assert.equal(result.equal, false)
  assert.deepEqual(result.changes, [
    { kind: 'changed', path: '/a~1b/~0key', before: 1, after: 2 },
    { kind: 'added', path: '/added', after: 'yes' },
    { kind: 'changed', path: '/array/1', before: 2, after: 3 },
    { kind: 'added', path: '/array/2', after: 4 },
    { kind: 'removed', path: '/removed', before: true },
  ])
  assert.equal(diffResponses(response('{"a":1,"b":[2]}'), response('{"b":[2],"a":1}')).equal, true)
  assert.equal(diffResponses(response('null'), response('false')).changes[0].path, '')
  assert.equal(diffResponses(response('{"__proto__":1}'), response('{"__proto__":2}')).changes[0].path, '/__proto__')
})
test('comparison falls back to text, compares binary bytes and refuses incomplete snapshots', () => {
  assert.deepEqual(diffResponses(response('first\nold\nlast'), response('first\nnew\nlast')).changes, [{ kind: 'changed', path: 'Line 2', before: 'old', after: 'new' }])
  assert.deepEqual(diffResponses(response('first\nlast'), response('first\nadded\nlast')).changes, [{ kind: 'added', path: 'Line 2', after: 'added' }])
  const binary = base64 => response('', { binary: true, bodyBase64: base64 })
  assert.equal(diffResponses(binary('AP8='), binary('AP8=')).equal, true)
  assert.equal(diffResponses(binary('AP8='), binary('AP9=')).equal, true)
  assert.equal(diffResponses(binary('AP8='), binary('AP4=')).equal, false)
  assert.ok(diffResponses(binary('AP8='), response('', { binary: true })).error)
  assert.ok(diffResponses(binary('AP8='), binary('invalid')).error)
  assert.ok(diffResponses(response('a', { bodyTruncated: true }), response('a')).error)
  assert.equal(diffResponses(response('{invalid'), response('{invalid')).equal, true)
})
test('large tree and comparison remain bounded and explicitly indicate incomplete traversal', () => {
  const many = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`key${i}`, i]))
  const tree = flattenJsonTree(many, new Set(['']), 1000)
  assert.equal(tree.rows.length, 1000); assert.equal(tree.truncated, true)
  assert.deepEqual(flattenJsonTree(many, new Set()).rows.map(row => row.path), [''])
  const changes = diffResponses(response(JSON.stringify(many)), response('{}'), 200)
  assert.equal(changes.changes.length, 200); assert.equal(changes.truncated, true); assert.equal(changes.equal, false)
  const deep = { child: { child: { child: 1 } } }
  assert.equal(flattenJsonTree(deep, new Set(['', '/child', '/child/child']), 100, 1).truncated, true)
  assert.equal(jsonPointer('/a', '~b/c'), '/a/~0b~1c')
})
test('invalid, binary and incomplete JSON do not produce misleading trees', () => {
  assert.equal(parseResponseJson(response('0')).ok, true)
  assert.equal(parseResponseJson(response('{invalid')).ok, false)
  assert.equal(parseResponseJson(response('{}', { binary: true })).ok, false)
  assert.equal(parseResponseJson(response('{}', { bodyTruncated: true })).ok, false)
  assert.equal(parseResponseJson(response(' '.repeat(2 * 1024 * 1024 + 1))).ok, false)
})
test('Pretty, tree, copying and comparison preserve large IDs and precise JSON numbers', () => {
  const source = '{"id":9007199254740993,"decimal":0.123456789012345678901,"huge":1e999,"tiny":1e-999,"label":"9007199254740993"}'
  const parsed = parseResponseJson(response(source)); assert.equal(parsed.ok, true)
  assert.equal(valueSummary(parsed.value.id), '9007199254740993')
  assert.equal(valueSummary(parsed.value.decimal), '0.123456789012345678901')
  assert.equal(formatResponseJson(source).replace(/\s/g, ''), source)
  assert.equal(stringifyResponseValue(parsed.value).replace(/\s/g, ''), source)
  assert.equal(diffResponses(response('{"id":9007199254740992}'), response('{"id":9007199254740993}')).equal, false)
  assert.equal(diffResponses(response('{"a":9007199254740993,"b":1e999}'), response('{"b":10e998,"a":9007199254740993.0}')).equal, true)
  assert.equal(flattenJsonTree(parsed.value, new Set([''])).rows.find(row => row.path === '/id').expandable, false)
})
test('all large root fields remain reachable through bounded JSON tree pages', () => {
  const source = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`key${i}`, i]))
  const first = flattenJsonTree(source, new Set(['']), 1000, 64, 0)
  const next = flattenJsonTree(source, new Set(['']), 1000, 64, 1000)
  assert.equal(first.rows.length, 1000); assert.equal(first.hasMore, true)
  assert.equal(next.rows[0].path, '/key999'); assert.equal(next.rows.at(-1).path, '/key1499'); assert.equal(next.hasMore, false)
  assert.equal(new Set([...first.rows, ...next.rows].map(row => row.path)).size, 1501)
})
