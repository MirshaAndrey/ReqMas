import test from 'node:test'
import assert from 'node:assert/strict'
import { sendRequest } from '../src/services/httpClient.ts'

const request = { id: 'r', collectionId: 'c', name: 'Connection test', method: 'GET', url: 'https://example.test/echo', headers: [], params: [], bodyType: 'none', body: '' }
const pair = (key, value) => ({ id: key, key, value, enabled: true })
const response = { status: 200, statusText: 'OK', duration: 1, size: 0, headers: {}, body: '' }
function desktopMock(t, invoke) {
  const previousWindow = globalThis.window, previousTauri = globalThis.isTauri
  globalThis.isTauri = true; globalThis.window = { __TAURI_INTERNALS__: { invoke } }
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; if (previousTauri === undefined) delete globalThis.isTauri; else globalThis.isTauri = previousTauri })
}
test('desktop forwards resolved connection options separately from the journal snapshot', async t => {
  let wire, journal
  desktopMock(t, (command, args) => { assert.equal(command, 'send_request'); wire = args.request; return response })
  await sendRequest({ ...request, variables: [pair('password', 'request-password')], connection: { proxyUrl: '{{proxy}}', proxyUsername: 'audit-user', proxyPassword: '{{password}}', caPem: 'PEM-CA', clientCertPem: 'PEM-CERT', clientKeyPem: '{{key}}' } }, new AbortController().signal, [pair('proxy', 'http://collection.test:8000'), pair('password', 'collection-password')], [pair('proxy', 'http://environment.test:8080'), pair('password', 'environment-password'), pair('key', 'private-key')], [], snapshot => { journal = snapshot })
  assert.deepEqual(wire.connection, { proxyUrl: 'http://environment.test:8080', proxyUsername: 'audit-user', proxyPassword: 'request-password', caPem: 'PEM-CA', clientCertPem: 'PEM-CERT', clientKeyPem: 'private-key' })
  assert.equal(journal.connection, undefined)
  for (const sensitive of ['environment.test', 'request-password', 'private-key', 'PEM-CERT']) assert.equal(JSON.stringify(journal).includes(sensitive), false)
})
test('browser rejects saved proxy or TLS options before making a network request', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch })
  let calls = 0; globalThis.fetch = () => { calls++; throw new Error('Unexpected fetch') }
  for (const connection of [{ proxyUrl: 'http://localhost:8080' }, { caPem: 'PEM-CA' }, { clientKeyPem: 'private-key' }]) await assert.rejects(() => sendRequest({ ...request, connection }, new AbortController().signal), /require Desktop mode/)
  assert.equal(calls, 0)
})
test('empty connection options still allow browser requests', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch })
  let calls = 0; globalThis.fetch = async () => { calls++; return new Response('ok', { headers: { 'Content-Type': 'text/plain' } }) }
  const result = await sendRequest({ ...request, connection: { proxyUrl: '', caPem: '   ' } }, new AbortController().signal)
  assert.equal(calls, 1); assert.equal(result.body, 'ok')
})
test('missing connection variable reports validation failure and never invokes desktop transport', async t => {
  let calls = 0; desktopMock(t, () => { calls++; return response })
  await assert.rejects(() => sendRequest({ ...request, connection: { proxyPassword: '{{missing}}' } }, new AbortController().signal), /Variable "missing" has no value/)
  assert.equal(calls, 0)
})
