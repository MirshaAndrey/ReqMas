import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackup, createExportBackup, parseBackup } from '../src/services/backup.ts'
import { exportCollection, exportEnvironment, importEnvironment } from '../src/services/workspace.ts'
import { importPostman } from '../src/services/postmanImport.ts'

const pair = (key, value, secret) => ({ id: key, key, value, enabled: true, ...(secret === undefined ? {} : { secret }) })
const oauth = () => ({ tokenUrl: 'https://auth.example.test/token', clientId: 'visible-client', clientSecret: 'oauth-secret', scope: 'openid', accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt: 123456, flow: 'authorization_code', authorizationUrl: 'https://auth.example.test/authorize', redirectUri: 'http://127.0.0.1:54321/callback', autoRefresh: true })
const request = () => ({ id: 'r', collectionId: 'c', name: 'Test', method: 'GET', url: 'https://example.test/api?token=query-secret&ordinary=keep', params: [pair('token', 'query-secret', true), pair('ordinary', 'keep')], headers: [pair('Authorization', 'header-auth'), pair('X-Visible', 'visible-header')], bodyType: 'none', body: '', variables: [pair('secretVar', 'request-secret', true), pair('publicVar', 'ordinary-value')], authMode: 'oauth', oauth: oauth(), basicAuth: { username: 'visible-user', password: 'basic-secret' }, bearerToken: 'bearer-secret', apiKey: { key: 'X-Key', value: 'api-secret', in: 'header' }, connection: { proxyUrl: 'http://user:embedded-proxy-secret@proxy.example.test:8080', proxyUsername: 'visible-proxy-user', proxyPassword: 'proxy-secret', caPem: 'public-CA', clientCertPem: 'public-certificate', clientKeyPem: 'private-key' } })
const workspace = () => ({ collections: [{ id: 'c', name: 'API', variables: [pair('collectionSecret', 'collection-secret', true), pair('baseUrl', 'https://example.test')], oauth: oauth(), basicAuth: { username: 'collection-user', password: 'collection-password' } }], requests: [request()], environments: [{ id: 'e', name: 'Dev', variables: [pair('token', 'env-secret', true), pair('other', 'public') ] }], environmentId: 'e', cookies: [{ id: 'cookie', name: 'session', value: 'cookie-secret', domain: 'example.test', path: '/', secure: true, hostOnly: true }], history: [{ id: 'h', request: request(), time: '2026-10-09T00:00:00Z', status: 200, duration: 1, response: { status: 200, statusText: 'OK', duration: 1, size: 2, body: '{}', headers: { 'set-cookie': 'history-cookie-secret', 'content-type': 'application/json' }, setCookies: ['session=history-cookie-secret; HttpOnly; Path=/'] } }], trash: { requests: [request()], collections: [{ id: 'trash-c', name: 'Deleted', oauth: oauth(), variables: [pair('deletedSecret', 'trash-secret', true)] }] } })

test('safe backup strips structured secrets in saved requests, drafts, history, trash and cookies without mutating originals', () => {
  const data = workspace(), drafts = [request()], before = structuredClone({ data, drafts })
  const backup = createExportBackup(data, 'dark', drafts), exported = JSON.stringify(backup)
  for (const secret of ['query-secret', 'request-secret', 'oauth-secret', 'access-token', 'refresh-token', 'basic-secret', 'bearer-secret', 'api-secret', 'proxy-secret', 'embedded-proxy-secret', 'private-key', 'collection-secret', 'collection-password', 'env-secret', 'cookie-secret', 'history-cookie-secret', 'trash-secret', 'header-auth']) assert.equal(exported.includes(secret), false, secret)
  assert.equal(backup.data.requests[0].url, 'https://example.test/api?token=&ordinary=keep')
  assert.equal(backup.data.requests[0].variables[0].secret, true)
  assert.equal(backup.data.requests[0].variables[1].value, 'ordinary-value')
  assert.equal(backup.data.requests[0].connection.caPem, 'public-CA')
  assert.equal(backup.data.requests[0].connection.clientCertPem, 'public-certificate')
  assert.equal(backup.data.requests[0].connection.proxyUsername, 'visible-proxy-user')
  assert.equal(backup.data.environments[0].variables[1].value, 'public')
  assert.equal(backup.data.history[0].response.setCookies[0], 'session=; HttpOnly; Path=/')
  assert.deepEqual({ data, drafts }, before)
  assert.doesNotThrow(() => parseBackup(exported))
})

test('explicit full export and internal backup retain all optional metadata and credentials as independent copies', () => {
  const data = workspace(), drafts = [request()]
  const internal = createBackup(data, 'system', drafts), exported = createExportBackup(data, 'system', drafts, { includeSecrets: true })
  assert.deepEqual(internal.data, data)
  assert.deepEqual(exported.data, data)
  assert.deepEqual(exported.drafts, drafts)
  assert.deepEqual(parseBackup(JSON.stringify(exported)).data, data)
  data.requests[0].oauth.refreshToken = 'changed'; drafts[0].connection.clientKeyPem = 'changed'
  assert.equal(exported.data.requests[0].oauth.refreshToken, 'refresh-token')
  assert.equal(exported.drafts[0].connection.clientKeyPem, 'private-key')
})

test('backup strictly validates secret flags and newly optional OAuth and connection fields in every request location', () => {
  const backup = createBackup(workspace(), 'dark', [request()])
  const locations = [b => b.data.requests[0], b => b.data.history[0].request, b => b.data.trash.requests[0], b => b.drafts[0]]
  for (const locate of locations) {
    for (const [key, value] of [['flow', 'implicit'], ['authorizationUrl', 3], ['redirectUri', null], ['refreshToken', {}], ['autoRefresh', 'true']]) {
      const next = structuredClone(backup); locate(next).oauth[key] = value
      assert.throws(() => parseBackup(JSON.stringify(next)), /oauth/)
    }
    for (const key of ['proxyUrl', 'proxyUsername', 'proxyPassword', 'caPem', 'clientCertPem', 'clientKeyPem']) {
      const next = structuredClone(backup); locate(next).connection[key] = false
      assert.throws(() => parseBackup(JSON.stringify(next)), /connection/)
    }
    const next = structuredClone(backup); locate(next).variables[0].secret = 'true'
    assert.throws(() => parseBackup(JSON.stringify(next)), /secret/)
  }
  for (const locate of [b => b.data.environments[0].variables[0], b => b.data.collections[0].variables[0], b => b.data.trash.collections[0].variables[0]]) {
    const next = structuredClone(backup); locate(next).secret = 1
    assert.throws(() => parseBackup(JSON.stringify(next)), /secret/)
  }
  const next = structuredClone(backup); next.data.requests[0].connection.clientKeyPem = 'x'.repeat(1024 * 1024 + 1)
  assert.throws(() => parseBackup(JSON.stringify(next)), /1 MiB/)
})

test('environment exports hide only marked values, retain secret metadata, and full exports roundtrip values', () => {
  const environment = workspace().environments[0], before = structuredClone(environment)
  const safe = exportEnvironment(environment)
  assert.deepEqual(safe.values.map(v => [v.key, v.value, v.type]), [['token', '', 'secret'], ['other', 'public', 'default']])
  const importedSafe = importEnvironment(JSON.stringify(safe))
  assert.equal(importedSafe.variables[0].secret, true)
  assert.equal(importedSafe.variables[0].value, '')
  const full = importEnvironment(JSON.stringify(exportEnvironment(environment, { includeSecrets: true })))
  assert.equal(full.variables[0].value, 'env-secret')
  assert.equal(full.variables[0].secret, true)
  assert.deepEqual(environment, before)
  assert.throws(() => importEnvironment(JSON.stringify({ name: 'Bad', values: [{ key: 'token', value: 'x', secret: 'yes' }] })), /secret must be true or false/)
})

test('collection export defaults remove secret values from both Postman auth and Reqmas metadata while retaining normal settings', () => {
  const data = workspace(), before = structuredClone(data)
  const safe = exportCollection(data.collections[0], data.requests), serialized = JSON.stringify(safe)
  for (const secret of ['query-secret', 'request-secret', 'oauth-secret', 'access-token', 'refresh-token', 'basic-secret', 'bearer-secret', 'api-secret', 'proxy-secret', 'embedded-proxy-secret', 'private-key', 'collection-secret', 'collection-password', 'header-auth']) assert.equal(serialized.includes(secret), false, secret)
  assert.equal(safe.variable[0].type, 'secret')
  assert.equal(safe.variable[0].value, '')
  assert.equal(safe.variable[1].value, 'https://example.test')
  assert.equal(safe.item[0].request.url.raw, 'https://example.test/api?token=&ordinary=keep')
  assert.equal(safe.item[0].reqdesk.oauth.authorizationUrl, 'https://auth.example.test/authorize')
  assert.equal(safe.item[0].reqdesk.connection.clientKeyPem, '')
  assert.deepEqual(data, before)
  const full = exportCollection(data.collections[0], data.requests, { includeSecrets: true })
  assert.equal(full.item[0].reqdesk.oauth.refreshToken, 'refresh-token')
  assert.equal(full.item[0].reqdesk.connection.clientKeyPem, 'private-key')
  assert.equal(full.variable[0].value, 'collection-secret')
})

test('ordinary variables sharing a value with a marked secret remain unchanged', () => {
  const data = workspace(); data.environments[0].variables = [pair('private', 'same', true), pair('public', 'same', false)]
  assert.deepEqual(createExportBackup(data, 'system').data.environments[0].variables.map(p => p.value), ['', 'same'])
})

test('credential templates retain their variable references after safe export', () => {
  const data = workspace(), r = data.requests[0]
  r.basicAuth.password = '{{password}}'; r.bearerToken = '{{token}}'; r.apiKey.value = '{{apiKey}}'
  r.oauth.clientSecret = '{{oauthSecret}}'; r.oauth.accessToken = '{{accessToken}}'; r.oauth.refreshToken = '{{refreshToken}}'
  r.connection.proxyPassword = '{{proxyPassword}}'
  r.headers = [pair('Authorization', 'Bearer {{token}}'), pair('X-Api-Key', '{{apiKey}}')]
  const safe = createExportBackup(data, 'dark').data.requests[0]
  assert.equal(safe.basicAuth.password, '{{password}}')
  assert.equal(safe.bearerToken, '{{token}}')
  assert.equal(safe.apiKey.value, '{{apiKey}}')
  assert.equal(safe.oauth.clientSecret, '{{oauthSecret}}')
  assert.equal(safe.oauth.accessToken, '{{accessToken}}')
  assert.equal(safe.oauth.refreshToken, '{{refreshToken}}')
  assert.equal(safe.connection.proxyPassword, '{{proxyPassword}}')
  assert.deepEqual(safe.headers.map(p => p.value), ['Bearer {{token}}', '{{apiKey}}'])
})

test('OAuth request and response history cannot reintroduce removed client secrets and tokens through text or byte copies', () => {
  const data = workspace(), entry = data.history[0]
  entry.request = { ...request(), name: 'OAuth token', authMode: 'none', oauth: undefined, bodyType: 'urlencoded', form: [pair('grant_type', 'authorization_code'), pair('client_id', 'public-client'), pair('client_secret', 'form-client-secret'), pair('code', 'one-use-code'), pair('code_verifier', 'pkce-secret'), pair('refresh_token', 'form-refresh-token')] }
  entry.response.body = '{"access_token":"issued-access","refresh_token":"issued-refresh","id":9007199254740993,"expires_in":3600,"nested":{"access_token":"{{looksLikeVariable}}"}}'
  entry.response.bodyBase64 = Buffer.from(entry.response.body).toString('base64')
  const before = structuredClone(data), safe = createExportBackup(data, 'dark')
  assert.deepEqual(safe.data.history[0].request.form.map(p => [p.key, p.value]), [['grant_type', 'authorization_code'], ['client_id', 'public-client'], ['client_secret', ''], ['code', ''], ['code_verifier', ''], ['refresh_token', '']])
  assert.equal(safe.data.history[0].response.body, '{"access_token":"","refresh_token":"","id":9007199254740993,"expires_in":3600,"nested":{"access_token":""}}')
  assert.equal(safe.data.history[0].response.bodyBase64, undefined)
  assert.deepEqual(data, before)
  assert.doesNotThrow(() => parseBackup(JSON.stringify(safe)))
  const full = createExportBackup(data, 'dark', [], { includeSecrets: true })
  assert.equal(full.data.history[0].response.bodyBase64, entry.response.bodyBase64)
  assert.equal(full.data.history[0].request.form.find(p => p.key === 'code').value, 'one-use-code')
})

test('full Postman export/import preserves advanced OAuth, connection and secret-variable metadata; safe roundtrip blanks only secrets', () => {
  const data = workspace(), collection = { ...data.collections[0], authMode: 'oauth' }
  const full = importPostman(JSON.stringify(exportCollection(collection, data.requests, { includeSecrets: true })))
  assert.deepEqual(full.collection.oauth, collection.oauth)
  assert.deepEqual(full.requests[0].oauth, data.requests[0].oauth)
  assert.deepEqual(full.requests[0].connection, data.requests[0].connection)
  assert.deepEqual(full.requests[0].variables.map(({ key, value, secret }) => ({ key, value, secret })), data.requests[0].variables.map(({ key, value, secret }) => ({ key, value, secret })))
  assert.equal(full.requests[0].params.find(p => p.key === 'token').secret, true)
  const safe = importPostman(JSON.stringify(exportCollection(collection, data.requests)))
  assert.equal(safe.collection.oauth.clientSecret, '')
  assert.equal(safe.collection.oauth.accessToken, '')
  assert.equal(safe.collection.oauth.refreshToken, '')
  assert.equal(safe.requests[0].oauth.flow, 'authorization_code')
  assert.equal(safe.requests[0].oauth.authorizationUrl, collection.oauth.authorizationUrl)
  assert.equal(safe.requests[0].oauth.redirectUri, collection.oauth.redirectUri)
  assert.equal(safe.requests[0].oauth.autoRefresh, true)
  assert.equal(safe.requests[0].connection.proxyPassword, '')
  assert.equal(safe.requests[0].connection.clientKeyPem, '')
  assert.equal(safe.requests[0].connection.caPem, 'public-CA')
  assert.equal(safe.requests[0].variables[0].secret, true)
  assert.equal(safe.requests[0].variables[0].value, '')
  assert.equal(safe.requests[0].variables[1].value, 'ordinary-value')
})

test('ordinary Postman OAuth Authorization Code and PKCE grant attributes map into supported settings', () => {
  for (const grant of ['authorization_code', 'authorization_code_with_pkce']) {
    const source = { info: { name: 'External OAuth' }, item: [{ name: 'Authorized', request: { method: 'GET', url: 'https://api.example.test', auth: { type: 'oauth2', oauth2: [ ['grant_type', grant], ['authUrl', 'https://auth.example.test/authorize'], ['accessTokenUrl', 'https://auth.example.test/token'], ['clientId', 'public-client'], ['redirect_uri', 'http://127.0.0.1:58809/oauth/callback'], ['accessToken', 'supplied-token'], ['refreshToken', 'supplied-refresh'] ].map(([key, value]) => ({ key, value })) } } }] }
    const imported = importPostman(JSON.stringify(source)).requests[0]
    assert.equal(imported.oauth.flow, 'authorization_code')
    assert.equal(imported.oauth.authorizationUrl, 'https://auth.example.test/authorize')
    assert.equal(imported.oauth.redirectUri, 'http://127.0.0.1:58809/oauth/callback')
    assert.equal(imported.oauth.accessToken, 'supplied-token')
    assert.equal(imported.oauth.refreshToken, 'supplied-refresh')
  }
})

test('Reqmas OAuth metadata takes precedence without wiping standard fields omitted from a partial extension', () => {
  const source = { info: { name: 'Metadata' }, item: [{ name: 'OAuth', request: { method: 'GET', url: 'https://api.example.test', auth: { type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'accessTokenUrl', value: 'https://auth.example.test/token' }, { key: 'clientId', value: 'client' }, { key: 'accessToken', value: 'provided' }] } }, reqdesk: { oauth: { flow: 'authorization_code', authorizationUrl: 'https://auth.example.test/authorize', redirectUri: 'http://127.0.0.1:58809/oauth/callback', refreshToken: 'refresh', autoRefresh: false }, connection: { proxyUrl: 'http://proxy.example.test:8080', caPem: 'public CA' } } }] }
  const imported = importPostman(JSON.stringify(source)).requests[0]
  assert.equal(imported.oauth.tokenUrl, 'https://auth.example.test/token')
  assert.equal(imported.oauth.clientId, 'client')
  assert.equal(imported.oauth.accessToken, 'provided')
  assert.equal(imported.oauth.flow, 'authorization_code')
  assert.equal(imported.oauth.autoRefresh, false)
  assert.deepEqual(imported.connection, { proxyUrl: 'http://proxy.example.test:8080', caPem: 'public CA' })
})

test('malformed optional Postman connection and OAuth metadata are reported without coercing unsafe values', () => {
  const source = { info: { name: 'Malformed metadata' }, item: [{ name: 'Request', request: { method: 'GET', url: 'https://api.example.test', auth: { type: 'oauth2', oauth2: [{ key: 'accessToken', value: 'provided' }] } }, reqdesk: { oauth: { flow: 'implicit', autoRefresh: 'yes', authorizationUrl: {}, refreshToken: false, expiresAt: -1 }, connection: { proxyPassword: false, clientKeyPem: 123, caPem: 'public CA' } } }] }
  const result = importPostman(JSON.stringify(source)), imported = result.requests[0]
  assert.equal(result.skipped, 0)
  assert.equal(imported.oauth.accessToken, 'provided')
  for (const field of ['flow', 'autoRefresh', 'authorizationUrl', 'refreshToken', 'expiresAt']) assert.equal(imported.oauth[field], undefined)
  assert.deepEqual(imported.connection, { caPem: 'public CA' })
  assert.equal(result.warnings.length, 7)
})

test('inactive OAuth metadata and imported secret flags survive future auth-mode switching', () => {
  const data = workspace(), collection = { ...data.collections[0], authMode: 'none' }, requests = [{ ...data.requests[0], authMode: 'none' }]
  const full = importPostman(JSON.stringify(exportCollection(collection, requests, { includeSecrets: true })))
  assert.equal(full.collection.authMode, 'none')
  assert.deepEqual(full.collection.oauth, collection.oauth)
  assert.equal(full.requests[0].authMode, 'none')
  assert.deepEqual(full.requests[0].oauth, requests[0].oauth)
  const external = { info: { name: 'Secret metadata' }, variable: [{ key: 'collection', value: 'c', type: 'secret' }], item: [{ name: 'Request', variable: [{ key: 'local', value: 'l', secret: true }], request: { method: 'GET', url: 'https://api.example.test' } }] }
  const imported = importPostman(JSON.stringify(external))
  assert.equal(imported.collection.variables[0].secret, true)
  assert.equal(imported.requests[0].variables[0].secret, true)
})
