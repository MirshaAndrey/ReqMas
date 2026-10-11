import test from 'node:test'
import assert from 'node:assert/strict'
import { bytesBase64, decodeResponseText, isBinaryResponse } from '../src/services/responseEncoding.ts'
import { requestSnapshot, completeJournal, displayHeaders } from '../src/services/requestJournal.ts'
import { appendHistory, responseValue } from '../src/services/responseData.ts'
import { responseBytes } from '../src/services/responseView.ts'
import { sendRequest } from '../src/services/httpClient.ts'

const enc = new TextEncoder()
const response = (extra = {}) => ({ status: 200, statusText: 'OK', duration: 42, size: 0, headers: { 'content-type': 'application/octet-stream' }, body: '', ...extra })
const request = { id: 'r', collectionId: 'c', name: 'Example', method: 'GET', url: 'https://example.test/file', headers: [], params: [], bodyType: 'none', body: '' }
const entry = (id, r) => ({ id, request, time: '2026-10-06T12:00:00Z', status: r.status, duration: r.duration, response: r })
const retainedSize = h => h.response ? enc.encode(h.response.body).length + (h.response.bodyBase64 === undefined ? 0 : Buffer.from(h.response.bodyBase64, 'base64').length) : 0

test('base64 transport round trips all byte values across chunk boundaries including empty and padded payloads', () => {
  for (const length of [0, 1, 2, 3, 32767, 32768, 32769, 100000]) {
    const raw = Uint8Array.from({ length }, (_, i) => i % 256)
    const base64 = bytesBase64(raw)
    assert.equal(base64, Buffer.from(raw).toString('base64'))
    assert.deepEqual(responseBytes(response({ binary: true, bodyBase64: base64 })), raw)
  }
})
test('content classification honors explicit text and structured media, binary formats and unknown UTF8/control bytes', () => {
  const binary = Uint8Array.of(0, 255, 1, 2)
  for (const type of ['text/plain', 'TEXT/HTML; charset=utf-8', 'application/json', 'application/problem+json', 'application/xml', 'application/javascript', 'application/yaml', 'application/graphql-response+json']) assert.equal(isBinaryResponse(binary, type), false, type)
  for (const type of ['image/png', 'image/jpeg', 'audio/ogg', 'video/mp4', 'font/woff2', 'application/pdf', 'application/octet-stream', 'application/zip', 'application/x-protobuf', 'application/wasm']) assert.equal(isBinaryResponse(enc.encode('readable'), type), true, type)
  assert.equal(isBinaryResponse(enc.encode('Привет 😀\n\t\r'), ''), false)
  assert.equal(isBinaryResponse(enc.encode('{"id":1}'), 'application/custom'), false)
  assert.equal(isBinaryResponse(Uint8Array.of(0xc3, 0x28), ''), true)
  assert.equal(isBinaryResponse(Uint8Array.of(65, 0, 66), 'application/custom'), true)
  assert.equal(isBinaryResponse(new Uint8Array(), ''), false)
})
test('response text honors explicit charsets, strips BOM and preserves original bytes for downloads', () => {
  const bom = Uint8Array.from([239, 187, 191, ...enc.encode('{"name":"Привет"}')])
  assert.equal(decodeResponseText(bom, 'application/json'), '{"name":"Привет"}')
  assert.equal(decodeResponseText(Uint8Array.of(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2), 'text/plain; charset="windows-1251"'), 'Привет')
  assert.equal(decodeResponseText(Uint8Array.of(255, 254, 65, 0, 66, 0), 'text/plain; charset=UTF-16LE'), 'AB')
  assert.equal(decodeResponseText(enc.encode('valid UTF8 😀'), 'text/plain; charset=unknown-charset'), 'valid UTF8 😀')
  assert.deepEqual(responseBytes(response({ body: decodeResponseText(bom), bodyBase64: bytesBase64(bom) })), bom)
})
function desktopMock(t, invoke) {
  const previousWindow = globalThis.window, previousTauri = globalThis.isTauri
  globalThis.isTauri = true; globalThis.window = { __TAURI_INTERNALS__: { invoke } }
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; if (previousTauri === undefined) delete globalThis.isTauri; else globalThis.isTauri = previousTauri })
}
test('Desktop preserves an explicit empty Cookie header over the jar and decodes raw text consistently', async t => {
  let wire
  const raw = Uint8Array.from([239, 187, 191, ...enc.encode('{"id":1}')])
  desktopMock(t, (command, args) => { assert.equal(command, 'send_request'); wire = args.request; return response({ binary: false, body: 'wrong old decoding', bodyBase64: bytesBase64(raw), headers: { 'Content-Type': 'application/json' } }) })
  const jar = [{ id: 'cookie', name: 'sid', value: 'secret', domain: 'example.test', path: '/', secure: true, hostOnly: true }]
  const result = await sendRequest({ ...request, headers: [{ id: 'header', key: 'Cookie', value: '', enabled: true }] }, new AbortController().signal, [], [], jar)
  assert.equal(wire.headers.cookie, ''); assert.equal(result.body, '{"id":1}'); assert.equal(result.bodyBase64, bytesBase64(raw))
})
test('Desktop cancellation dispatches matching request ID and never publishes a late response', async t => {
  const controller = new AbortController(), calls = []
  desktopMock(t, (command, args) => { calls.push({ command, args }); if (command === 'send_request') { controller.abort(); return response() } })
  await assert.rejects(() => sendRequest(request, controller.signal), { name: 'AbortError' })
  assert.deepEqual(calls.map(call => call.command), ['send_request', 'cancel_request'])
  assert.equal(calls[0].args.requestId, calls[1].args.requestId)
})
test('capture keeps large IDs and precise decimal values exact and refuses incomplete JSON snapshots', () => {
  const r = response({ body: '{"id":9007199254740993,"decimal":0.123456789012345678901}' })
  assert.equal(responseValue(r, 'json', 'id'), '9007199254740993')
  assert.equal(responseValue(r, 'json', 'decimal'), '0.123456789012345678901')
  assert.equal(responseValue(r, 'json', '$'), r.body)
  assert.throws(() => responseValue({ ...r, bodyTruncated: true }, 'json', 'id'), /incomplete/)
})
test('request journal captures a detached request with bounded valid UTF8 and without mutating the prepared payload', () => {
  const prepared = { method: 'POST', url: 'https://example.test/a?q=1', headers: { Authorization: 'Bearer abc', 'Content-Type': 'text/plain' }, body: 'a'.repeat(100 * 1024 - 1) + '😀tail' }
  const before = structuredClone(prepared)
  const snapshot = requestSnapshot(prepared)
  assert.deepEqual(prepared, before)
  assert.equal(snapshot.bodyTruncated, true)
  assert.ok(enc.encode(snapshot.body).length <= 100 * 1024)
  assert.equal(snapshot.body, 'a'.repeat(100 * 1024 - 1))
  assert.ok(!snapshot.body.includes('�'))
  prepared.headers.Authorization = 'changed'; prepared.body = 'changed'
  assert.equal(snapshot.headers.Authorization, 'Bearer abc')
  assert.equal(snapshot.method, 'POST'); assert.equal(snapshot.url, 'https://example.test/a?q=1')
  assert.equal(requestSnapshot({ method: 'GET', url: 'https://example.test', headers: {} }).body, undefined)
  assert.equal(requestSnapshot({ method: 'POST', url: 'https://example.test', headers: {}, body: 'x'.repeat(100 * 1024) }).bodyTruncated, false)
})
test('binary request journal records the exact byte count without storing the payload', () => {
  for (const size of [0, 1, 2, 3, 102400]) {
    const snapshot = requestSnapshot({ method: 'POST', url: 'https://example.test', headers: {}, bodyBase64: bytesBase64(new Uint8Array(size)) })
    assert.equal(snapshot.binarySize, size)
    assert.equal(snapshot.body, undefined)
    assert.equal(Object.hasOwn(snapshot, 'bodyBase64'), false)
  }
})
test('journal completion preserves the original request and captures final URL, timings, status and redirect metadata', () => {
  const pending = { id: 'j', name: 'Get file', startedAt: '2026-10-06T12:00:00Z', transport: 'desktop', state: 'sending', request: requestSnapshot({ method: 'GET', url: 'https://example.test/start', headers: {} }) }
  const before = structuredClone(pending)
  const r = response({ status: 404, statusText: 'Not Found', url: 'https://example.test/final', headersDuration: 25, downloadDuration: 17, headers: { 'content-type': 'text/plain', 'x-id': 'abc' }, redirects: [{ from: 'https://example.test/start', to: 'https://example.test/final', status: 302 }] })
  const complete = completeJournal(pending, r)
  assert.deepEqual(pending, before)
  assert.equal(complete.state, 'complete'); assert.equal(complete.status, 404); assert.equal(complete.statusText, 'Not Found')
  assert.equal(complete.duration, 42); assert.equal(complete.headersDuration, 25); assert.equal(complete.downloadDuration, 17)
  assert.equal(complete.finalUrl, 'https://example.test/final'); assert.deepEqual(complete.redirects, r.redirects); assert.deepEqual(complete.responseHeaders, r.headers)
  assert.deepEqual(complete.request, pending.request)
  r.headers['x-id'] = 'changed'; r.redirects[0].status = 307
  assert.equal(complete.responseHeaders['x-id'], 'abc'); assert.equal(complete.redirects[0].status, 302)
})
test('journal hides common credential headers until explicitly revealed', () => {
  const headers = { Authorization: 'Bearer abc', 'X-API-Key': 'secret', 'X-Key': 'custom-credential', Cookie: 'sid=value', 'X-Access-Token': 'token', 'Content-Type': 'application/json', Accept: '*/*' }
  const hidden = displayHeaders(headers)
  for (const secret of ['Bearer abc', 'secret', 'custom-credential', 'sid=value', ': token']) assert.ok(!hidden.includes(secret))
  assert.ok(hidden.includes('Content-Type: application/json')); assert.ok(hidden.includes('Accept: */*'))
  const revealed = displayHeaders(headers, true)
  assert.ok(revealed.includes('Authorization: Bearer abc')); assert.ok(revealed.includes('X-API-Key: secret'))
  assert.equal(displayHeaders({}), '(no explicit headers)')
})
test('binary history retains an exact 100 KiB boundary payload and drops larger raw byte snapshots', () => {
  const exact = response({ binary: true, size: 100 * 1024, bodyBase64: bytesBase64(new Uint8Array(100 * 1024)) })
  const kept = appendHistory(entry('exact', exact), [])[0]
  assert.equal(kept.bodyTruncated, undefined)
  assert.equal(kept.response.bodyBase64, exact.bodyBase64)
  const large = response({ binary: true, size: 100 * 1024 + 1, bodyBase64: bytesBase64(new Uint8Array(100 * 1024 + 1)) })
  const clipped = appendHistory(entry('large', large), [])[0]
  assert.equal(clipped.bodyTruncated, true); assert.equal(clipped.response.bodyTruncated, true); assert.equal(clipped.response.bodyBase64, undefined)
  assert.equal(clipped.response.size, 100 * 1024 + 1); assert.equal(clipped.response.status, 200)
  assert.throws(() => responseBytes(clipped.response), /incomplete/)
  assert.equal(large.bodyBase64.length, bytesBase64(new Uint8Array(100 * 1024 + 1)).length)
})
test('history budget includes raw bytes as well as displayed text and cannot be bypassed with empty binary bodies', () => {
  const raw = bytesBase64(new Uint8Array(90000))
  const binary = response({ binary: true, size: 90000, bodyBase64: raw })
  const prior = Array.from({ length: 130 }, (_, i) => entry(String(i), binary))
  const history = appendHistory(entry('new', binary), prior)
  assert.equal(history.length, 100)
  assert.ok(history.reduce((sum, h) => sum + retainedSize(h), 0) <= 1024 * 1024)
  assert.ok(history.every(h => retainedSize(h) <= 100 * 1024))
  assert.ok(history.some(h => h.bodyTruncated && h.response.bodyBase64 === undefined))
  assert.equal(prior.length, 130); assert.equal(prior[0].response.bodyBase64, raw); assert.equal(prior[0].bodyTruncated, undefined)
  const text = '😀'.repeat(18000)
  const mixed = response({ headers: { 'content-type': 'text/plain' }, body: text, bodyBase64: bytesBase64(enc.encode(text)), size: enc.encode(text).length })
  const clipped = appendHistory(entry('text', mixed), [])[0]
  assert.equal(clipped.bodyTruncated, true); assert.equal(clipped.response.bodyBase64, undefined)
  assert.equal(clipped.response.body, text); assert.ok(!clipped.response.body.includes('�'))
  assert.equal(mixed.bodyBase64, bytesBase64(enc.encode(text)))
})

test('discarded oversized binary payloads do not consume the budget for older retained bodies', () => {
  const large = response({ binary: true, size: 120000, bodyBase64: bytesBase64(new Uint8Array(120000)) })
  const text = 'Привет 😀'.repeat(1000)
  const older = entry('older-text', response({ body: text, size: enc.encode(text).length, headers: { 'content-type': 'text/plain' } }))
  const previous = [...Array.from({ length: 12 }, (_, i) => entry(String(i), large)), older]
  const history = appendHistory(entry('new', large), previous)
  assert.ok(history.slice(0, -1).every(h => retainedSize(h) === 0 && h.bodyTruncated))
  assert.equal(history.at(-1).response.body, text)
  assert.equal(history.at(-1).bodyTruncated, undefined)
  assert.equal(history.reduce((sum, h) => sum + retainedSize(h), 0), enc.encode(text).length)
  assert.equal(previous.at(-1).response.body, text)
})
