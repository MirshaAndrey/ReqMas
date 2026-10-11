import test from 'node:test'
import assert from 'node:assert/strict'
import { readResponseBytes } from '../src/services/responseLimit.ts'

test('bounded response reader preserves every byte and accepts exactly the limit', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(0, 255)); controller.enqueue(Uint8Array.of(13, 10)); controller.close() } }))
  assert.deepEqual(await readResponseBytes(response, new AbortController().signal, 4), Uint8Array.of(0, 255, 13, 10))
  assert.deepEqual(await readResponseBytes(new Response(null, { status: 204 }), new AbortController().signal, 4), new Uint8Array())
})
test('oversized declared and chunked responses are cancelled before accumulating unbounded data', async () => {
  let cancelled = 0
  const declared = new Response(new ReadableStream({ cancel() { cancelled++ } }), { headers: { 'content-length': '104857601' } })
  await assert.rejects(readResponseBytes(declared, new AbortController().signal), /100 MiB/); assert.equal(cancelled, 1)
  const streamed = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)) }, cancel() { cancelled++ } }))
  await assert.rejects(readResponseBytes(streamed, new AbortController().signal, 4), /size limit/); assert.equal(cancelled, 2)
})
test('cancellation interrupts a stalled response stream and does not publish partial bytes', async () => {
  const controller = new AbortController(); let cancelled = false
  const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(Uint8Array.of(1)) }, cancel() { cancelled = true } }))
  const reading = readResponseBytes(response, controller.signal)
  await Promise.resolve(); controller.abort()
  await assert.rejects(reading, /abort/i); assert.equal(cancelled, true)
})

test('pre-cancelled reading rejects before locking or consuming a response stream', async () => {
  const controller = new AbortController(), reason = new DOMException('Already cancelled', 'AbortError')
  controller.abort(reason)
  const response = new Response(Uint8Array.of(0, 255, 13, 10))
  await assert.rejects(readResponseBytes(response, controller.signal, 4), error => error === reason)
  assert.equal(response.body.locked, false)
  assert.equal(response.bodyUsed, false)
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(0, 255, 13, 10))
  await assert.rejects(readResponseBytes(new Response(null, { status: 204 }), controller.signal, 4), error => error === reason)
})
