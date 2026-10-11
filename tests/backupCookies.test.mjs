import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackup, parseBackup } from '../src/services/backup.ts'
import { captureCookies, cookiesFor, validCookie } from '../src/services/workspace.ts'
import { requestTimeout, tokenExpiry } from '../src/services/requestOptions.ts'

const now = Date.parse('2026-10-06T00:00:00Z')
const cookie = (extra = {}) => ({ id: 'sid', name: 'sid', value: 'value', domain: 'example.test', path: '/', secure: true, hostOnly: true, ...extra })
const pair = (id = 'p') => ({ id, key: 'key', value: 'value', enabled: true })
const request = () => ({ id: 'r', collectionId: 'c', name: 'Example', method: 'GET', url: 'https://example.test/', headers: [], params: [], bodyType: 'none', body: '' })
const workspace = () => ({ collections: [{ id: 'c', name: 'API', variables: [] }], requests: [request()], environments: [{ id: 'env', name: 'Dev', variables: [] }], environmentId: 'env', cookies: [cookie()], history: [{ id: 'h', request: request(), status: 200, duration: 1, time: new Date(now).toISOString() }], trash: { requests: [], collections: [] } })

test('invalid Max-Age falls back to Expires and cannot resurrect an expired cookie', () => {
  for (const maxAge of ['oops', '', '1.5', '+60', '1e3']) {
    const jar = captureCookies('https://example.test/', [`sid=new; Path=/; Max-Age=${maxAge}; Expires=Wed, 01 Jan 2020 00:00:00 GMT`], [cookie()], now)
    assert.deepEqual(jar, [], maxAge)
  }
  const jar = captureCookies('https://example.test/', ['sid=new; Max-Age=60; Expires=Wed, 01 Jan 2020 00:00:00 GMT'], [], now)
  assert.equal(jar[0].expiresAt, now + 60000)
  assert.equal(cookiesFor('https://example.test/', jar, now + 60000), '')
})

test('huge cookie Max-Age stays finite and zero or negative Max-Age deletes the matching cookie', () => {
  const jar = captureCookies('https://example.test/', [`sid=value; Max-Age=${'9'.repeat(400)}`], [], now)
  assert.equal(jar[0].expiresAt, 8640000000000000)
  assert.equal(Number.isNaN(new Date(jar[0].expiresAt).getTime()), false)
  for (const maxAge of ['0', '-1', '-' + '9'.repeat(400)]) assert.deepEqual(captureCookies('https://example.test/', [`sid=; Path=/; Max-Age=${maxAge}`], [cookie()], now), [])
})

test('cookie capture ignores malformed names and header control characters and trims outer value whitespace', () => {
  assert.deepEqual(captureCookies('https://example.test/', ['bad name=x', 'sid=x\r\nInjected: true', 'sid=x\u0000'], [], now), [])
  const jar = captureCookies('https://example.test/a/b', ['  sid = value  ; Path=relative'], [], now)
  assert.equal(jar[0].value, 'value')
  assert.equal(jar[0].path, '/a')
  assert.equal(cookiesFor('https://example.test/a/child', jar, now), 'sid=value')
  assert.equal(cookiesFor('https://example.test/another', jar, now), '')
})

test('cookie validation accepts canonical IPv6 and normal host names while unsafe saved cookies never become request headers', () => {
  const ipv6 = cookie({ domain: '[::1]' })
  assert.equal(validCookie(ipv6), true)
  assert.equal(cookiesFor('https://[::1]/', [ipv6], now), 'sid=value')
  assert.equal(cookiesFor('https://example.test/', [cookie({ domain: 'EXAMPLE.TEST' })], now), 'sid=value')
  for (const invalid of [cookie({ name: 'bad name' }), cookie({ value: 'injected\r\nX: y' }), cookie({ value: 'part; extra=x' }), cookie({ domain: 'example.test:80' }), cookie({ domain: 'example..test' }), cookie({ domain: 'other@example.test' }), cookie({ path: '/\n' }), cookie({ expiresAt: Infinity }), {}]) {
    assert.equal(validCookie(invalid), false)
    assert.equal(cookiesFor('https://example.test/', [invalid], now), '')
  }
})

test('backup rejects duplicated or empty IDs that would make editors modify multiple rows at once', () => {
  const paths = [
    b => b.data.requests[0].params = [pair(), pair()],
    b => b.data.requests[0].headers = [pair('')],
    b => b.data.requests[0].variables = [pair(), pair()],
    b => b.data.collections[0].variables = [pair(), pair()],
    b => b.data.environments[0].variables = [pair(), pair()],
    b => b.data.environments[0].id = '',
    b => b.data.cookies.push(cookie()),
    b => b.data.history.push(structuredClone(b.data.history[0])),
    b => b.data.requests[0].tests = [1, 2].map(() => ({ id: 'test', kind: 'status', key: '', expected: '200', enabled: true })),
    b => b.data.requests[0].extractions = [1, 2].map(() => ({ id: 'capture', source: 'json', path: 'id', variable: 'id', enabled: true })),
    b => b.data.requests[0].files = [1, 2].map(() => ({ id: 'file', key: 'file', name: 'data.bin', type: 'application/octet-stream', base64: 'AP8=', enabled: true })),
  ]
  for (const mutate of paths) {
    const backup = createBackup(workspace(), 'dark')
    mutate(backup)
    assert.throws(() => parseBackup(JSON.stringify(backup)), /duplicate or empty ID/)
  }
})

test('backup permits repeated request IDs in history drafts and preserves safe cookie settings', () => {
  const backup = createBackup(workspace(), 'dark', [request(), request()])
  backup.data.cookies[0] = cookie({ domain: '[::1]' })
  const restored = parseBackup(JSON.stringify(backup))
  assert.equal(restored.drafts.length, 2)
  assert.equal(restored.drafts[0].id, restored.drafts[1].id)
  assert.equal(restored.data.history[0].request.id, restored.drafts[0].id)
  assert.equal(restored.data.cookies[0].domain, '[::1]')
})

test('backup refuses unsafe cookie fields before restoration can affect the jar', () => {
  for (const invalid of [{ name: 'bad name' }, { value: '\r\nX: yes' }, { domain: 'user@example.test' }, { path: '\n/' }]) {
    const backup = createBackup(workspace(), 'dark')
    Object.assign(backup.data.cookies[0], invalid)
    assert.throws(() => parseBackup(JSON.stringify(backup)), /cookie.name, value, domain or path/)
  }
})

test('OAuth zero lifetime expires immediately, huge lifetimes remain serializable and malformed lifetimes stay unset', context => {
  context.mock.method(Date, 'now', () => now)
  assert.equal(tokenExpiry(0), now)
  assert.equal(tokenExpiry(60), now + 60000)
  assert.equal(tokenExpiry(Number.MAX_VALUE), 8640000000000000)
  assert.equal(JSON.parse(JSON.stringify({ expiresAt: tokenExpiry(Number.MAX_VALUE) })).expiresAt, 8640000000000000)
  for (const invalid of [NaN, Infinity, -Infinity, -1]) assert.equal(tokenExpiry(invalid), undefined)
  assert.equal(requestTimeout({ timeoutMs: NaN }), 30000)
  assert.equal(requestTimeout({ timeoutMs: -1 }), 100)
  assert.equal(requestTimeout({ timeoutMs: 400000 }), 300000)
})
