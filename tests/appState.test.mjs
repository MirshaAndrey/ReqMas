import test from 'node:test'
import assert from 'node:assert/strict'
import { read, write, writeWorkspace, restoreWorkspace } from '../src/storage/database.ts'
import { moveRequestFolder, planFolderMove } from '../src/services/folderMoves.ts'
import { formatJsonTemplate } from '../src/services/jsonEditor.ts'
import { mergeDeletedItems, normalizeTrash, renewedOAuth, upsertSavedRequest } from '../src/services/appState.ts'
import { createBackup, parseBackup } from '../src/services/backup.ts'
import { OAuthTokenManager, oauthIdentity } from '../src/services/oauth.ts'

const request = (extra = {}) => ({ id: 'r', collectionId: 'c', name: 'Example', method: 'GET', url: 'https://example.test', params: [], headers: [], bodyType: 'none', body: '', ...extra })
const data = (name = 'Example') => ({ collections: [{ id: 'c', name }], requests: [request({ name })], environments: [], environmentId: '', cookies: [], history: [], trash: { requests: [], collections: [] } })

function storageCheck(run) {
  const previous = globalThis.localStorage
  const entries = new Map()
  let reject = false, writes = 0
  globalThis.localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { writes++; if (reject) throw new Error('QuotaExceededError'); entries.set(key, value) } }
  try { run({ entries, reject: value => { reject = value }, writes: () => writes }) }
  finally { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous }
}

test('workspace restore commits data, drafts and theme in one write and leaves every value intact on quota failure', () => storageCheck(store => {
  store.entries.set('reqdesk.theme', JSON.stringify('dark'))
  store.entries.set('reqdesk.tabs', JSON.stringify([{ request: request({ name: 'Legacy draft' }) }]))
  writeWorkspace(data('Original'))
  const before = new Map(store.entries), draft = request({ name: 'Unsaved restored draft' })
  store.reject(true)
  assert.throws(() => restoreWorkspace(data('Replacement'), [draft], 'light'), /Quota/)
  assert.deepEqual(store.entries, before)
  assert.equal(read('requests', [])[0].name, 'Original')
  assert.equal(read('tabs', [])[0].request.name, 'Legacy draft')
  assert.equal(read('theme', ''), 'dark')
  store.reject(false)
  const writes = store.writes()
  restoreWorkspace(data('Replacement'), [draft], 'light')
  assert.equal(store.writes(), writes + 1)
  assert.equal(read('requests', [])[0].name, 'Replacement')
  assert.equal(read('tabs', [])[0].request.name, draft.name)
  assert.equal(read('theme', ''), 'light')
}))

test('ordinary workspace, theme and draft saves preserve the other records after atomic restoration', () => storageCheck(() => {
  restoreWorkspace(data(), [request({ name: 'Restored draft' })], 'dark')
  write('theme', 'light')
  write('tabs', [{ request: request({ name: 'Edited draft' }) }])
  writeWorkspace(data('Edited workspace'))
  assert.equal(read('theme', ''), 'light')
  assert.equal(read('tabs', [])[0].request.name, 'Edited draft')
  assert.equal(read('requests', [])[0].name, 'Edited workspace')
}))

test('a corrupt workspace document still permits recovery of intact legacy records', () => storageCheck(store => {
  store.entries.set('reqdesk.workspace', '{incomplete')
  store.entries.set('reqdesk.requests', JSON.stringify([request({ name: 'Recovered' })]))
  assert.equal(read('requests', [])[0].name, 'Recovered')
}))

test('folder moves treat prototype names as ordinary paths and never move a request using inherited properties', () => {
  const folders = ['constructor', '__proto__', 'toString', 'Users/Admin']
  const planned = planFolderMove(folders, folders, {}, 'Users', 'People')
  for (const path of folders.slice(0, 3)) assert.equal(moveRequestFolder(request({ folder: path }), 'c', planned.moves).folder, path)
  assert.equal(moveRequestFolder(request({ folder: 'Users/Admin' }), 'c', planned.moves).folder, 'People/Admin')
  assert.equal(moveRequestFolder(request({ folder: 'constructor' }), 'c', {}).folder, 'constructor')
  const renamed = planFolderMove(folders, folders, {}, '__proto__', 'Prototype')
  assert.equal(moveRequestFolder(request({ folder: '__proto__' }), 'c', renamed.moves).folder, 'Prototype')
  assert.equal(moveRequestFolder(request({ folder: '__proto__', collectionId: 'other' }), 'c', renamed.moves).folder, '__proto__')
  assert.deepEqual(folders, ['constructor', '__proto__', 'toString', 'Users/Admin'])
})

test('multiple nested folder edits compose for saved requests and drafts, including removal to the root', () => {
  const first = planFolderMove(['Users', 'Users/Admin'], ['Users/Admin', 'Users/Draft'], {}, 'Users', 'People')
  const second = planFolderMove(first.folders, ['Users/Admin', 'Users/Draft'], first.moves, 'People', 'Accounts')
  assert.equal(moveRequestFolder(request({ folder: 'Users/Admin' }), 'c', second.moves).folder, 'Accounts/Admin')
  assert.equal(moveRequestFolder(request({ folder: 'Users/Draft' }), 'c', second.moves).folder, 'Accounts/Draft')
  const removed = planFolderMove(second.folders, ['Users/Admin'], second.moves, 'Accounts', '')
  assert.equal(moveRequestFolder(request({ folder: 'Users/Admin' }), 'c', removed.moves).folder, '')
  assert.deepEqual(removed.folders, [])
})

test('formatting request JSON preserves large IDs, high precision decimals and unquoted templates exactly', () => {
  const formatted = formatJsonTemplate('{"id":9007199254740993,"decimal":0.1234567890123456789,"zero":-0,"user":{{userId}},"literal":"9007199254740993 {{userId}}"}')
  assert.ok(formatted.includes('"id": 9007199254740993'))
  assert.ok(formatted.includes('"decimal": 0.1234567890123456789'))
  assert.ok(formatted.includes('"zero": -0'))
  assert.ok(formatted.includes('"user": {{userId}}'))
  assert.ok(formatted.includes('"literal": "9007199254740993 {{userId}}"'))
  assert.throws(() => formatJsonTemplate('{"bad":01}'))
})

test('saving a deleted history snapshot and deleting its collection keeps one restorable latest request', () => {
  const original = request({ body: 'original body' }), historical = request({ body: 'history body', name: 'Saved history' })
  let saved = [original], deleted = { requests: [], collections: [] }
  deleted.requests = mergeDeletedItems(deleted.requests, saved)
  saved = upsertSavedRequest([], historical)
  deleted.requests = mergeDeletedItems(deleted.requests, saved)
  deleted.collections = mergeDeletedItems(deleted.collections, [{ id: 'c', name: 'Example' }])
  assert.equal(deleted.requests.length, 1)
  assert.deepEqual(deleted.requests[0], historical)
  const restored = { ...data(), requests: deleted.requests, collections: deleted.collections, trash: { requests: [], collections: [] } }
  assert.equal(parseBackup(JSON.stringify(createBackup(restored, 'system'))).data.requests[0].body, 'history body')
  assert.equal(original.body, 'original body')
})

test('legacy duplicate deleted requests and collections retain their complete latest versions', () => {
  const latest = request({ body: 'latest', oauth: { tokenUrl: 'https://example.test/token', clientId: 'client', clientSecret: 'secret', scope: '', accessToken: 'token' } })
  const normalized = normalizeTrash({ requests: [request(), latest], collections: [{ id: 'c', name: 'Old' }, { id: 'c', name: 'Latest', folders: ['Nested'] }] })
  assert.deepEqual(normalized.requests, [latest])
  assert.deepEqual(normalized.collections, [{ id: 'c', name: 'Latest', folders: ['Nested'] }])
})

test('asynchronous OAuth renewal preserves credentials manually changed in another request snapshot', async () => {
  const manager = new OAuthTokenManager(), controller = new AbortController()
  const source = { tokenUrl: 'https://example.test/token', clientId: 'client', clientSecret: '', scope: '', accessToken: 'expired', refreshToken: 'old', expiresAt: 1 }
  const next = await manager.ensure(oauthIdentity(source), source, controller.signal, async current => ({ ...current, accessToken: 'renewed', refreshToken: 'rotated', expiresAt: Date.now() + 60000 }))
  const publish = current => renewedOAuth(current, source, next, source, [], manager)
  const editedAccess = { ...source, accessToken: 'another-account', expiresAt: undefined }
  const editedRefresh = { ...source, refreshToken: 'manually-pasted' }
  assert.equal(publish(editedAccess), editedAccess)
  assert.equal(publish(editedRefresh), editedRefresh)
  assert.equal(publish(source).accessToken, 'renewed')
  const changedConfig = { ...source, scope: 'edited scope' }
  assert.equal(publish(changedConfig), changedConfig)
})

test('OAuth publication accepts a known earlier rotation and preserves raw variable configuration', async () => {
  const manager = new OAuthTokenManager(), signal = new AbortController().signal
  const raw = { tokenUrl: 'https://example.test/token', clientId: '{{client}}', clientSecret: '', scope: '', accessToken: '{{token}}', refreshToken: '{{refresh}}', expiresAt: 1 }
  const source = { ...raw, clientId: 'resolved-client', accessToken: 'old', refreshToken: 'old-refresh' }
  const key = oauthIdentity(source)
  const first = await manager.ensure(key, source, signal, async current => ({ ...current, accessToken: 'first', refreshToken: 'first-refresh', expiresAt: Date.now() + 60000 }))
  const second = await manager.ensure(key, first, signal, async current => ({ ...current, accessToken: 'second', refreshToken: 'second-refresh', expiresAt: Date.now() + 60000 }), true)
  const priorPublished = { ...raw, accessToken: first.accessToken, refreshToken: first.refreshToken, expiresAt: first.expiresAt }
  const variables = [{ id: 'client', key: 'client', value: 'resolved-client', enabled: true }, { id: 'token', key: 'token', value: 'old', enabled: true }, { id: 'refresh', key: 'refresh', value: 'old-refresh', enabled: true }]
  const updated = renewedOAuth(priorPublished, raw, second, source, variables, manager)
  assert.equal(updated.accessToken, 'second')
  assert.equal(updated.refreshToken, 'second-refresh')
  assert.equal(updated.clientId, '{{client}}')
  assert.equal(renewedOAuth(raw, raw, first, source, variables, manager).accessToken, 'first')
  assert.equal(renewedOAuth(raw, raw, first, source, variables, manager).clientId, '{{client}}')
  const editedVariables = variables.map(variable => variable.key === 'token' ? { ...variable, value: 'another-account' } : variable)
  assert.equal(renewedOAuth(raw, raw, first, source, editedVariables, manager), raw)
  const editedClient = variables.map(variable => variable.key === 'client' ? { ...variable, value: 'other-client' } : variable)
  assert.equal(renewedOAuth(raw, raw, first, source, editedClient, manager), raw)
  assert.equal(renewedOAuth(raw, raw, first, source, [], manager), raw)
})
