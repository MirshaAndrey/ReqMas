import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizationUrl, createPkce, validateRedirectUri, tokenRequest, receivedToken, OAuthTokenManager, oauthIdentity, resolveOAuth } from '../src/services/oauth.ts'
import { prepareRequest } from '../src/services/prepareRequest.ts'
import { validateUpdateSettings } from '../src/services/updateSettings.ts'
import { backupFromStored } from '../src/services/storedBackup.ts'
import { APP_VERSION } from '../src/version.ts'
import fs from 'node:fs'

const oauth = (extra = {}) => ({ tokenUrl: 'https://provider.example/token', clientId: 'public-app', clientSecret: '', scope: 'profile', accessToken: '', flow: 'authorization_code', authorizationUrl: 'https://provider.example/authorize', redirectUri: 'http://127.0.0.1:58809/oauth/callback', ...extra })
const request = { id: 'r', collectionId: 'c', name: 'Protected', method: 'GET', url: 'https://api.example/data', params: [], headers: [], bodyType: 'none', body: '', connection: { proxyUrl: 'http://127.0.0.1:8080', clientKeyPem: 'private-key' } }
const response = data => ({ status: 200, statusText: 'OK', duration: 1, size: 0, headers: {}, body: JSON.stringify(data) })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('PKCE uses random verifier/state, S256, exact redirect and replaces reserved authorization parameters', async () => {
  const first = await createPkce(), second = await createPkce()
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(first.verifier, second.verifier); assert.notEqual(first.state, second.state)
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(first.verifier))).toString('base64url')
  assert.equal(first.challenge, expected)
  const url = new URL(authorizationUrl(oauth({ authorizationUrl: 'https://provider.example/authorize?state=old&state=extra&prompt=consent' }), first))
  assert.deepEqual(url.searchParams.getAll('state'), [first.state]); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('prompt'), 'consent')
  assert.equal(url.searchParams.get('redirect_uri'), oauth().redirectUri); assert.equal(url.searchParams.has('client_secret'), false)
  for (const redirect of ['http://127.0.0.1:0/cb', 'http://localhost:58809/cb', 'https://127.0.0.1:58809/cb', 'http://127.0.0.1:58809/cb?code=old', 'http://user@127.0.0.1:58809/cb']) assert.throws(() => validateRedirectUri(redirect))
  assert.throws(() => authorizationUrl(oauth({ authorizationUrl: 'http://provider.example/login' }), first), /HTTPS/)
})
test('authorization code and refresh grants preserve connection settings and put credentials only in their selected location', () => {
  const code = tokenRequest(request, oauth(), { code: 'one+two', verifier: 'verifier' })
  assert.equal(code.form.find(p => p.key === 'code_verifier').value, 'verifier'); assert.equal(code.form.find(p => p.key === 'redirect_uri').value, oauth().redirectUri)
  assert.equal(code.form.some(p => p.key === 'client_secret'), false); assert.deepEqual(code.connection, request.connection); assert.equal(code.authMode, 'none')
  const refreshed = tokenRequest(request, oauth({ clientSecret: 'secret', clientAuth: 'basic' }), { refresh: 'rotating-token' })
  assert.equal(refreshed.form.find(p => p.key === 'grant_type').value, 'refresh_token'); assert.equal(refreshed.form.some(p => p.key === 'client_secret'), false); assert.equal(refreshed.basicAuth.password, 'secret')
  assert.equal(refreshed.params.length, 0); assert.equal(refreshed.url, oauth().tokenUrl)
  assert.throws(() => resolveOAuth(oauth({ clientId: '{{missing}}' }), []), /missing/)
})
test('OAuth Basic credentials use form encoding before base64 so reserved characters reach the correct client', () => {
  const config = oauth({ clientId: 'client:id', clientSecret: 'secret+value é%', clientAuth: 'basic' })
  const prepared = prepareRequest(tokenRequest(request, config, undefined))
  const credentials = Buffer.from(prepared.headers.authorization.slice(6), 'base64').toString('utf8').split(':')
  assert.equal(credentials.length, 2)
  const decode = value => new URLSearchParams(`value=${value}`).get('value')
  assert.deepEqual(credentials.map(decode), [config.clientId, config.clientSecret])
  assert.equal(new URLSearchParams(prepared.body).has('client_secret'), false)
})
test('token responses rotate refresh tokens and strictly reject malformed token fields and lifetimes', () => {
  const token = receivedToken(oauth({ refreshToken: 'old' }), response({ access_token: 'access', token_type: 'Bearer', refresh_token: 'rotated', expires_in: '60' }))
  assert.equal(token.refreshToken, 'rotated'); assert.ok(token.expiresAt > Date.now()); assert.equal(receivedToken(token, response({ access_token: 'next' })).refreshToken, 'rotated')
  for (const lifetime of [null, '', false, -1, 'unknown', {}, ' 2 ', Infinity]) assert.throws(() => receivedToken(oauth(), response({ access_token: 'access', expires_in: lifetime })), /expires_in/)
  assert.throws(() => receivedToken(oauth(), response({ access_token: '', expires_in: 60 })), /access_token/)
  assert.throws(() => receivedToken(oauth(), response({ access_token: 'a', token_type: 'MAC' })), /token_type/)
  assert.throws(() => receivedToken(oauth(), { ...response({ access_token: 'a' }), status: 302 }), /HTTP 302/)
})
test('concurrent OAuth sends spend a rotating refresh token once and a later expired send uses the rotated token', async () => {
  const manager = new OAuthTokenManager(), signal = new AbortController().signal, gate = deferred(), calls = []
  const source = oauth({ accessToken: 'expired', refreshToken: 'old', expiresAt: 1 })
  const acquire = async current => { calls.push(current.refreshToken); await gate.promise; return { ...current, accessToken: 'fresh', refreshToken: 'rotated', expiresAt: Date.now() + 60000 } }
  const a = manager.ensure('account', source, signal, acquire), b = manager.ensure('account', source, signal, acquire); gate.resolve()
  const [one, two] = await Promise.all([a, b]); assert.deepEqual(calls, ['old']); assert.equal(one.accessToken, two.accessToken)
  await manager.ensure('account', { ...one, expiresAt: 1, accessToken: 'manually-edited' }, signal, async current => { calls.push(current.refreshToken); return { ...current, accessToken: 'manual-new', expiresAt: Date.now() + 60000 } })
  assert.deepEqual(calls, ['old', 'rotated'])
})
test('different users with the same OAuth client and empty access tokens refresh independently', async () => {
  const manager = new OAuthTokenManager(), signal = new AbortController().signal, gate = deferred(), calls = []
  const first = oauth({ refreshToken: 'user-one-refresh' }), second = oauth({ refreshToken: 'user-two-refresh' })
  assert.equal(oauthIdentity(first), oauthIdentity(second))
  const acquire = async current => { calls.push(current.refreshToken); await gate.promise; return { ...current, accessToken: `${current.refreshToken}-access`, refreshToken: `${current.refreshToken}-rotated`, expiresAt: Date.now() + 60000 } }
  const a = manager.ensure(oauthIdentity(first), first, signal, acquire), b = manager.ensure(oauthIdentity(second), second, signal, acquire)
  gate.resolve()
  const [one, two] = await Promise.all([a, b])
  assert.deepEqual(calls.sort(), ['user-one-refresh', 'user-two-refresh'])
  assert.notEqual(one.accessToken, two.accessToken)
  assert.equal((await manager.ensure(oauthIdentity(first), first, signal, acquire)).accessToken, one.accessToken)
  assert.equal((await manager.ensure(oauthIdentity(second), second, signal, acquire)).accessToken, two.accessToken)
  assert.equal(calls.length, 2)
})
test('different expired access-token snapshots sharing a refresh grant spend its rotating token once', async () => {
  const manager = new OAuthTokenManager(), signal = new AbortController().signal, gate = deferred(), calls = []
  const first = oauth({ accessToken: 'expired-one', refreshToken: 'shared-refresh', expiresAt: 1 })
  const second = { ...first, accessToken: 'expired-two' }
  const acquire = async current => { calls.push(current.refreshToken); await gate.promise; return { ...current, accessToken: 'fresh-access', refreshToken: 'rotated-refresh', expiresAt: Date.now() + 60000 } }
  const a = manager.ensure('client', first, signal, acquire), b = manager.ensure('client', second, signal, acquire)
  gate.resolve()
  const [one, two] = await Promise.all([a, b])
  assert.deepEqual(calls, ['shared-refresh'])
  assert.equal(one.accessToken, two.accessToken)
  assert.equal((await manager.ensure('client', second, signal, acquire)).refreshToken, 'rotated-refresh')
  assert.equal(calls.length, 1)
})
test('OAuth configurations imported with different property order share their rotating grant', async () => {
  const first = oauth({ accessToken: 'expired', refreshToken: 'shared-refresh', expiresAt: 1 })
  const second = Object.fromEntries(Object.entries(first).reverse())
  assert.equal(oauthIdentity(first), oauthIdentity(second))
  const manager = new OAuthTokenManager(), signal = new AbortController().signal
  let calls = 0
  const acquire = async current => { calls++; return { ...current, accessToken: 'fresh', refreshToken: 'rotated', expiresAt: Date.now() + 60000 } }
  const [one, two] = await Promise.all([manager.ensure(oauthIdentity(first), first, signal, acquire), manager.ensure(oauthIdentity(second), second, signal, acquire)])
  assert.equal(calls, 1)
  assert.equal(one.accessToken, two.accessToken)
})
test('OAuth defaults and automatic refresh policy do not split the same rotating grant', async () => {
  const source = oauth({ flow: undefined, clientAuth: undefined, accessToken: 'expired', refreshToken: 'shared-refresh', expiresAt: 1 })
  const versions = [source, { ...source, clientAuth: 'body' }, { ...source, flow: 'client_credentials' }, { ...source, autoRefresh: true }, { ...source, autoRefresh: false }]
  assert.equal(new Set(versions.map(oauthIdentity)).size, 1)
  const manager = new OAuthTokenManager(), signal = new AbortController().signal
  let calls = 0
  const tokens = await Promise.all(versions.map(config => manager.ensure(oauthIdentity(config), config, signal, async current => { calls++; return { ...current, accessToken: 'fresh', refreshToken: 'rotated', expiresAt: Date.now() + 60000 } })))
  assert.equal(calls, 1)
  assert.ok(tokens.every(token => token.accessToken === 'fresh'))
  assert.equal(tokens[3].autoRefresh, true)
  assert.equal(tokens[4].autoRefresh, false)
})
test('all old snapshots of one grant use its latest rotated refresh token', async () => {
  const manager = new OAuthTokenManager(), signal = new AbortController().signal, source = oauth({ accessToken: 'old-access', refreshToken: 'original-refresh', expiresAt: 1 }), calls = []
  const first = await manager.ensure('client', source, signal, async current => { calls.push(current.refreshToken); return { ...current, accessToken: 'first-access', refreshToken: 'first-refresh', expiresAt: 1 } })
  const next = await manager.ensure('client', first, signal, async current => { calls.push(current.refreshToken); return { ...current, accessToken: 'second-access', refreshToken: 'second-refresh', expiresAt: Date.now() + 60000 } })
  const unexpected = () => { throw new Error('A stale snapshot must reuse the latest token') }
  assert.equal((await manager.ensure('client', source, signal, unexpected)).accessToken, next.accessToken)
  assert.equal((await manager.ensure('client', first, signal, unexpected)).accessToken, next.accessToken)
  assert.equal(manager.sameGrant('client', source, next), true)
  assert.equal(manager.sameGrant('client', first, next), true)
  assert.equal(manager.sameGrant('client', source, { ...next, accessToken: 'manually-replaced-access' }), false)
  assert.equal(manager.sameGrant('client', source, { ...next, refreshToken: 'manually-replaced-refresh' }), false)
  assert.deepEqual(calls, ['original-refresh', 'first-refresh'])
})
test('editing a refresh token does not revive the cached account even when the access token is unchanged', async () => {
  const manager = new OAuthTokenManager(), signal = new AbortController().signal, calls = []
  const source = oauth({ accessToken: 'same-access', refreshToken: 'old-refresh', expiresAt: 1 })
  const acquire = async current => { calls.push(current.refreshToken); return { ...current, accessToken: `${current.refreshToken}-access`, expiresAt: Date.now() + 60000 } }
  await manager.ensure('client', source, signal, acquire)
  const edited = await manager.ensure('client', { ...source, refreshToken: 'manually-replaced-refresh' }, signal, acquire)
  assert.equal(edited.accessToken, 'manually-replaced-refresh-access')
  assert.deepEqual(calls, ['old-refresh', 'manually-replaced-refresh'])
})
test('fresh sign-ins create separate grants and never inherit another user refresh token', async () => {
  const manager = new OAuthTokenManager(), signal = new AbortController().signal, source = oauth()
  const first = await manager.ensure('client', source, signal, async current => receivedToken(current, response({ access_token: 'user-one-access', refresh_token: 'user-one-refresh', expires_in: 60 })), true)
  const second = await manager.ensure('client', first, signal, async current => receivedToken(current, response({ access_token: 'user-two-access', expires_in: 60 })), true)
  assert.equal(second.refreshToken, '')
  const unexpected = () => { throw new Error('Existing grants must keep their own cached tokens') }
  assert.equal((await manager.ensure('client', first, signal, unexpected)).accessToken, first.accessToken)
  assert.equal((await manager.ensure('client', second, signal, unexpected)).accessToken, second.accessToken)
  assert.equal(manager.sameGrant('client', first, second), false)
})
test('cancelled OAuth waiter returns promptly without cancelling another refresh or later acquiring a token', async () => {
  const manager = new OAuthTokenManager(), gate = deferred(), waiting = new AbortController(), source = oauth()
  let calls = 0
  const acquire = async current => { calls++; await gate.promise; return { ...current, accessToken: 'new', expiresAt: Date.now() + 60000 } }
  const first = manager.ensure('account', source, new AbortController().signal, acquire)
  const second = manager.ensure('account', source, waiting.signal, acquire); waiting.abort()
  await assert.rejects(second, /abort/i); assert.equal(calls, 1); gate.resolve(); assert.equal((await first).accessToken, 'new')
  assert.equal((await manager.ensure('account', source, new AbortController().signal, acquire)).accessToken, 'new'); assert.equal(calls, 1)
})
test('clearing OAuth cache during an active acquisition never repopulates the restored workspace cache', async () => {
  const manager = new OAuthTokenManager(), gate = deferred(), source = oauth(); let calls = 0
  const acquire = async current => { calls++; await gate.promise; return { ...current, accessToken: 'new', expiresAt: Date.now() + 60000 } }
  const old = manager.ensure('account', source, new AbortController().signal, acquire); await Promise.resolve(); manager.clear(); gate.resolve(); await old
  await manager.ensure('account', source, new AbortController().signal, acquire); assert.equal(calls, 2)
})
test('updater can stay unconfigured and requires HTTPS plus an actual Minisign public key shape', () => {
  assert.deepEqual(validateUpdateSettings({ endpoint: '', publicKey: '' }), { endpoint: '', publicKey: '' })
  const bytes = Buffer.alloc(42); bytes.write('Ed'); const key = Buffer.from(`untrusted comment: test key\n${bytes.toString('base64')}\n`).toString('base64')
  assert.equal(validateUpdateSettings({ endpoint: ' https://updates.example/latest.json ', publicKey: key }).endpoint, 'https://updates.example/latest.json')
  for (const endpoint of ['http://updates.example/', 'https://user:password@updates.example/', 'https://updates.example/#download', 'file:///update']) assert.throws(() => validateUpdateSettings({ endpoint, publicKey: key }))
  assert.throws(() => validateUpdateSettings({ endpoint: 'https://updates.example/', publicKey: 'not-a-key' }))
})
test('automatic backup preview validates drafts and profiles before it can replace current data', () => {
  const stored = { collections: [{ id: 'c', name: 'API' }], requests: [request], history: [], environments: [], environmentId: '', cookies: [], trash: { requests: [], collections: [] }, theme: 'dark', tabs: [{ request }], runnerScenarios: [] }
  assert.equal(backupFromStored(JSON.stringify(stored)).drafts[0].name, 'Protected')
  assert.throws(() => backupFromStored(JSON.stringify({ ...stored, tabs: [{}] })), /backup/)
  assert.throws(() => backupFromStored(JSON.stringify({ ...stored, requests: [{ ...request, connection: { clientKeyPem: false } }] })), /connection/)
})
test('desktop, installer and frontend report the same release version and require signed update versions', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))), config = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url)))
  const cargo = fs.readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
  assert.equal(pkg.version, APP_VERSION); assert.equal(config.version, APP_VERSION); assert.match(cargo, new RegExp(`version = "${APP_VERSION.replaceAll('.', '\\.') }"`))
  assert.equal(config.plugins.updater.requireSignedVersion, true); assert.equal(config.bundle.active, true)
})
