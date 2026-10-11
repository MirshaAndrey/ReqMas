import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { collectLegacyWorkspace, createDesktopWorkspaceStore, parseWorkspaceRecord } from '../src/storage/desktopStore.ts'
import { read, write, writeWorkspace, restoreWorkspace, validateWorkspaceUpdate } from '../src/storage/database.ts'
import { createStorageCloseGuard, installStorageCloseGuard } from '../src/storage/closeGuard.ts'

const record = (name = 'Example') => ({ collections: [{ id: 'c', name }], requests: [], environments: [], environmentId: '', cookies: [], history: [], trash: { requests: [], collections: [] }, theme: 'dark', tabs: [], updates: { endpoint: 'https://example.test/update' }, navigationCollapsed: ['c'] })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const validRequest = (id = 'request', collectionId = 'c') => ({ id, collectionId, name: 'Request', method: 'GET', url: 'https://example.test', params: [], headers: [], bodyType: 'none', body: '' })
function legacyStorage(entries) { return { get length() { return entries.size }, key: index => [...entries.keys()][index] ?? null, getItem: key => entries.get(key) ?? null, removeItem: key => entries.delete(key) } }

test('legacy collection gathers workspace, drafts, theme and arbitrary metadata without touching unrelated data', () => {
  const original = record('Primary'); delete original.theme; delete original.tabs
  const entries = new Map([['reqdesk.workspace', JSON.stringify(original)], ['reqdesk.theme', '"light"'], ['reqdesk.tabs', JSON.stringify([{ request: validRequest() }])], ['reqdesk.futureMetadata', '{"key":5}'], ['reqmas.navigation.collapsed', '["folder"]'], ['unrelated.setting', 'leave alone']])
  const legacy = collectLegacyWorkspace(legacyStorage(entries))
  assert.equal(legacy.record.theme, 'light'); assert.equal(legacy.record.tabs[0].request.id, 'request')
  assert.deepEqual(legacy.record.futureMetadata, { key: 5 })
  assert.deepEqual(legacy.record.navigationCollapsed, ['c'])
  assert.equal(entries.size, 6)
  legacy.remove(); assert.deepEqual([...entries], [['unrelated.setting', 'leave alone']])
})

test('legacy requests without saved collections recover their original collection references', () => {
  const entries = new Map([['reqdesk.requests', JSON.stringify([validRequest('demo-r', 'demo'), validRequest('r', '__proto__')])]])
  const legacy = collectLegacyWorkspace(legacyStorage(entries))
  assert.deepEqual(legacy.record.collections, [{ id: 'demo', name: 'Demo API' }, { id: '__proto__', name: 'Recovered collection' }])
  assert.equal(legacy.record.requests.length, 2)
})

test('corrupt legacy data blocks migration and never removes the original bytes', () => {
  const entries = new Map([['reqdesk.workspace', '{broken'], ['reqdesk.theme', '"dark"']]), before = new Map(entries)
  assert.throws(() => collectLegacyWorkspace(legacyStorage(entries)), /Cannot migrate/)
  assert.deepEqual(entries, before)
})

test('desktop initializes from SQLite before exposing the synchronous cache and does not consult legacy storage', async () => {
  const calls = [], loading = deferred()
  const store = createDesktopWorkspaceStore(async command => { calls.push(command); return loading.promise }, () => { throw new Error('Must not read legacy data') }, () => {})
  assert.throws(() => store.get(), /not finished loading/)
  const first = store.initialize(), second = store.initialize()
  loading.resolve(JSON.stringify(record()))
  await Promise.all([first, second])
  assert.deepEqual(calls, ['load_workspace'])
  assert.equal(store.get().collections[0].name, 'Example')
  assert.deepEqual(store.get().updates, { endpoint: 'https://example.test/update' })
})

test('a SQLite read failure blocks initialization without falling back or saving, then permits retry', async () => {
  let failed = true, saves = 0, migrated = 0
  const store = createDesktopWorkspaceStore(async command => { if (command === 'save_workspace') saves++; if (failed) throw new Error('Database is locked'); return JSON.stringify(record()) }, () => { migrated++; return { record: record('Legacy'), remove() {} } }, () => {})
  await assert.rejects(store.initialize(), /locked/)
  assert.throws(() => store.get(), /not finished loading/)
  assert.equal(saves, 0); assert.equal(migrated, 0)
  failed = false
  await store.initialize()
  assert.equal(store.get().collections[0].name, 'Example')
})

test('migration removes plaintext legacy data only after the first durable save succeeds', async () => {
  let rejectSave = true, removed = false, saved
  const legacy = { record: record('Migrated'), remove: () => { removed = true } }
  const store = createDesktopWorkspaceStore(async (command, args) => { if (command === 'load_workspace') return null; saved = args.workspace; if (rejectSave) throw new Error('Disk is full') }, () => legacy, () => {})
  await assert.rejects(store.initialize(), /Disk is full/)
  assert.equal(removed, false)
  assert.throws(() => store.get(), /not finished loading/)
  rejectSave = false
  await store.initialize()
  assert.equal(removed, true)
  assert.equal(JSON.parse(saved).collections[0].name, 'Migrated')
  assert.deepEqual(store.get().navigationCollapsed, ['c'])
})

test('metadata written by child effects is included in the first complete desktop workspace commit', async () => {
  const saves = []
  const store = createDesktopWorkspaceStore(async (command, args) => { if (command === 'load_workspace') return null; saves.push(JSON.parse(args.workspace)) }, () => undefined, () => {})
  await store.initialize()
  store.metadata('theme', 'light'); store.metadata('tabs', [{ request: validRequest('draft') }])
  assert.equal(saves.length, 0)
  store.replace({ ...record(), ...store.get() })
  await store.flush()
  assert.equal(saves.length, 1)
  assert.equal(saves[0].theme, 'light'); assert.equal(saves[0].tabs[0].request.id, 'draft')
})

test('desktop commits are serialized and retain the latest metadata even when older writes are slow', async () => {
  const firstSave = deferred(), saves = [], started = []
  const store = createDesktopWorkspaceStore(async (command, args) => {
    if (command === 'load_workspace') return JSON.stringify(record())
    const value = JSON.parse(args.workspace); started.push(value.theme)
    if (started.length === 1) await firstSave.promise
    saves.push(value)
  }, () => undefined, () => {})
  await store.initialize()
  store.metadata('theme', 'light'); store.metadata('tabs', [{ request: validRequest('updated') }])
  await tick()
  assert.deepEqual(started, ['light'])
  assert.equal(store.get().tabs[0].request.id, 'updated')
  firstSave.resolve()
  await store.flush()
  assert.equal(saves.length, 2)
  assert.equal(saves[1].theme, 'light'); assert.equal(saves[1].tabs[0].request.id, 'updated')
  assert.deepEqual(saves[1].updates, record().updates)
})

test('flush also waits for writes queued while an earlier commit is in progress', async () => {
  const first = deferred(), second = deferred()
  let saves = 0, flushed = false
  const store = createDesktopWorkspaceStore(async command => { if (command === 'load_workspace') return JSON.stringify(record()); return ++saves === 1 ? first.promise : second.promise }, () => undefined, () => {})
  await store.initialize(); store.metadata('theme', 'light')
  const flushing = store.flush().then(() => { flushed = true })
  await tick(); store.metadata('tabs', [{ request: validRequest() }]); first.resolve()
  await tick(); assert.equal(saves, 2); assert.equal(flushed, false)
  second.resolve(); await flushing; assert.equal(flushed, true)
})

test('failed background saves emit an error and flush rejects until a newer full commit succeeds', async () => {
  let rejectSave = true
  const errors = [], saves = []
  const store = createDesktopWorkspaceStore(async (command, args) => { if (command === 'load_workspace') return JSON.stringify(record()); if (rejectSave) throw new Error('Disk quota'); saves.push(JSON.parse(args.workspace)) }, () => undefined, error => errors.push(error.message))
  await store.initialize()
  store.metadata('theme', 'light')
  await assert.rejects(store.flush(), /Disk quota/)
  assert.deepEqual(errors, ['Disk quota'])
  assert.equal(store.get().theme, 'light')
  rejectSave = false
  store.metadata('tabs', [{ request: validRequest('recovered') }])
  await store.flush()
  assert.equal(saves[0].theme, 'light'); assert.equal(saves[0].tabs[0].request.id, 'recovered')
})

test('an explicit retry durably saves the latest cached draft after a temporary storage error', async () => {
  let rejectSave = true, saved
  const store = createDesktopWorkspaceStore(async (command, args) => { if (command === 'load_workspace') return JSON.stringify(record()); if (rejectSave) throw new Error('Locked'); saved = JSON.parse(args.workspace) }, () => undefined, () => {})
  await store.initialize(); store.metadata('theme', 'light')
  await assert.rejects(store.flush(), /Locked/)
  rejectSave = false; await store.retry()
  assert.equal(saved.theme, 'light'); await store.flush()
})

test('the desktop close guard waits for saves, blocks duplicate closes and permits the final native close', async () => {
  const saving = deferred(), blocked = []
  let flushes = 0, closes = 0, prevented = 0
  const guard = createStorageCloseGuard(() => { flushes++; return saving.promise }, async () => { closes++ }, () => assert.fail('Unexpected save failure'), value => blocked.push(value))
  const event = { preventDefault() { prevented++ } }, first = guard(event)
  await guard(event)
  assert.equal(flushes, 1); assert.equal(closes, 0); assert.equal(prevented, 2)
  saving.resolve(); await first; await guard(event)
  assert.equal(closes, 1); assert.equal(prevented, 2); assert.deepEqual(blocked, [true, false])
})

test('the close guard leaves the app editable after save failure and allows a later retry', async () => {
  let failed = true, closes = 0
  const errors = [], blocked = []
  const guard = createStorageCloseGuard(async () => { if (failed) throw new Error('Quota') }, async () => { closes++ }, error => errors.push(error.message), value => blocked.push(value))
  await guard({ preventDefault() {} })
  assert.equal(closes, 0); assert.deepEqual(errors, ['Quota']); assert.deepEqual(blocked, [true, false])
  failed = false; await guard({ preventDefault() {} }); assert.equal(closes, 1)
})

test('native close uses a permitted destroy command only after the workspace is durable', async () => {
  const capability = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/main.json', import.meta.url)))
  const saving = deferred(), calls = [], blocked = []
  let listener
  const appWindow = {
    async onCloseRequested(handler) { listener = handler; return () => { listener = undefined } },
    async destroy() {
      if (!capability.windows.includes('main') || !capability.permissions.includes('core:window:allow-destroy')) throw new Error('window.destroy not allowed')
      calls.push('destroy')
    },
  }
  const unlisten = await installStorageCloseGuard(appWindow, () => saving.promise, error => assert.fail(String(error)), value => blocked.push(value))
  let prevented = false
  const closing = listener({ preventDefault() { prevented = true } })
  assert.equal(prevented, true); assert.deepEqual(calls, [])
  saving.resolve(); await closing
  assert.deepEqual(calls, ['destroy']); assert.deepEqual(blocked, [true, false])
  unlisten(); assert.equal(listener, undefined)
})

test('native window command failure is reported and permits retry without trapping editing', async () => {
  let listener, rejectDestroy = true, destroyed = false
  const errors = [], blocked = []
  const appWindow = {
    async onCloseRequested(handler) { listener = handler; return () => {} },
    async destroy() { if (rejectDestroy) throw new Error('Native close failed'); destroyed = true },
  }
  await installStorageCloseGuard(appWindow, async () => {}, error => errors.push(error.message), value => blocked.push(value))
  await listener({ preventDefault() {} })
  assert.equal(destroyed, false); assert.deepEqual(errors, ['Native close failed'])
  rejectDestroy = false; await listener({ preventDefault() {} })
  assert.equal(destroyed, true); assert.deepEqual(blocked, [true, false, true, false])
})

test('restore waits for its durable commit and leaves the old cache on failure', async () => {
  const committing = deferred(), errors = []
  const store = createDesktopWorkspaceStore(async command => command === 'load_workspace' ? JSON.stringify(record()) : committing.promise, () => undefined, error => errors.push(error.message))
  await store.initialize()
  const restoring = store.restore(record('Restored'))
  assert.equal(store.get().collections[0].name, 'Example')
  assert.throws(() => store.metadata('theme', 'light'), /restoration/)
  committing.reject(new Error('Restore quota'))
  await assert.rejects(restoring, /Restore quota/)
  assert.equal(store.get().collections[0].name, 'Example')
  assert.deepEqual(errors, ['Restore quota'])
})

test('successful restoration updates cache only after all previous writes and forces a recoverable snapshot', async () => {
  const firstSave = deferred(), calls = [], flags = []
  const store = createDesktopWorkspaceStore(async (command, args) => { if (command === 'load_workspace') return JSON.stringify(record()); const name = JSON.parse(args.workspace).collections[0].name; calls.push(name); flags.push(args.forceBackup); if (calls.length === 1) await firstSave.promise }, () => undefined, () => {})
  await store.initialize()
  store.replace(record('Edited'))
  const restoring = store.restore(record('Restored'))
  await tick(); assert.deepEqual(calls, ['Edited'])
  assert.equal(store.get().collections[0].name, 'Edited')
  firstSave.resolve(); await restoring; await store.flush()
  assert.deepEqual(calls, ['Edited', 'Restored'])
  assert.deepEqual(flags, [undefined, true])
  assert.equal(store.get().collections[0].name, 'Restored')
})

test('native backups support nonmutating preview and atomically update the cache on restore', async () => {
  const calls = [], restored = record('Backup')
  const store = createDesktopWorkspaceStore(async (command, args) => { calls.push([command, args]); if (command === 'load_workspace') return JSON.stringify(record()); if (command === 'list_workspace_backups') return [{ id: 1, createdAt: 1, size: 30 }]; return JSON.stringify(restored) }, () => undefined, () => {})
  await store.initialize()
  assert.deepEqual(await store.listBackups(), [{ id: 1, createdAt: 1, size: 30 }])
  assert.equal((await store.loadBackup(1)).collections[0].name, 'Backup')
  assert.equal(store.get().collections[0].name, 'Example')
  assert.equal((await store.restoreBackup(1)).collections[0].name, 'Backup')
  assert.equal(store.get().collections[0].name, 'Backup')
  assert.deepEqual(calls.slice(-2).map(item => item[0]), ['read_workspace_backup', 'restore_workspace_backup'])
  await assert.rejects(store.restoreBackup(-1), /valid workspace backup/)
})

test('malformed native documents and invalid backup previews never trigger a save or restore', async () => {
  const calls = []
  const store = createDesktopWorkspaceStore(async command => { calls.push(command); return command === 'load_workspace' ? JSON.stringify(record()) : '{broken' }, () => undefined, () => {})
  await store.initialize()
  await assert.rejects(store.restoreBackup(1), /invalid JSON/)
  assert.ok(!calls.includes('restore_workspace_backup'))
  assert.equal(store.get().collections[0].name, 'Example')
  assert.throws(() => parseWorkspaceRecord('[]'), /invalid document/)
  assert.throws(() => parseWorkspaceRecord('{}'), /missing collections/)
})

test('malformed native request entries block startup before any automatic save can overwrite them', async () => {
  const original = record(); original.requests = [{ id: 'broken', collectionId: 'c' }]
  const calls = []
  const store = createDesktopWorkspaceStore(async command => { calls.push(command); return JSON.stringify(original) }, () => undefined, () => {})
  await assert.rejects(store.initialize(), /Invalid workspace backup/)
  assert.deepEqual(calls, ['load_workspace'])
  assert.throws(() => store.get(), /not finished loading/)
})

test('complete desktop commits reject records that would fail on restart before changing cache or database', async () => {
  const initial = record(), calls = []
  const store = createDesktopWorkspaceStore(async (command, args) => { calls.push([command, args]); return JSON.stringify(initial) }, () => undefined, () => {})
  await store.initialize()
  const bad = record('Rejected'); bad.requests = [{ ...validRequest(), headers: {} }]
  assert.throws(() => store.replace(bad), /Invalid workspace backup/)
  await assert.rejects(store.restore(bad), /Invalid workspace backup/)
  assert.throws(() => store.metadata('tabs', [{ request: { id: 'bad' } }]), /Invalid workspace backup/)
  const tooMany = record('Too many'); tooMany.requests = Array.from({ length: 10001 }, (_, i) => validRequest(`request-${i}`))
  assert.throws(() => store.replace(tooMany), /requests/)
  await store.flush()
  assert.deepEqual(store.get(), initial)
  assert.deepEqual(calls.map(([command]) => command), ['load_workspace'])
})

test('desktop startup repairs legacy duplicate trash IDs without losing the latest content or overwriting saved bytes', async () => {
  const saved = record(), latest = { ...validRequest(), name: 'Saved from history', body: 'complete content' }
  saved.trash.requests = [validRequest(), latest]
  saved.trash.collections = [{ id: 'deleted', name: 'Old' }, { id: 'deleted', name: 'Latest', folders: ['Nested'] }]
  const source = JSON.stringify(saved), calls = []
  const store = createDesktopWorkspaceStore(async command => { calls.push(command); return source }, () => undefined, () => {})
  await store.initialize()
  assert.deepEqual(store.get().trash.requests, [latest])
  assert.deepEqual(store.get().trash.collections, [{ id: 'deleted', name: 'Latest', folders: ['Nested'] }])
  assert.deepEqual(calls, ['load_workspace'])
  assert.equal(saved.trash.requests.length, 2)
})

test('legacy migration commits the repaired trash before removing old local storage', async () => {
  const legacy = record(), latest = { ...validRequest(), body: 'most recent delete' }
  legacy.trash.requests = [validRequest(), latest]
  let removed = false, committed
  const store = createDesktopWorkspaceStore(async (command, args) => {
    if (command === 'load_workspace') return null
    committed = JSON.parse(args.workspace)
  }, () => ({ record: legacy, remove() { removed = true } }), () => {})
  await store.initialize()
  assert.equal(removed, true)
  assert.deepEqual(committed.trash.requests, [latest])
  assert.deepEqual(store.get().trash.requests, [latest])
  assert.equal(legacy.trash.requests.length, 2)
})

test('browser invalid complete workspace and draft writes preserve the last valid document', () => {
  const previous = globalThis.localStorage, entries = new Map()
  globalThis.localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) }
  try {
    writeWorkspace(record())
    const before = entries.get('reqdesk.workspace'), bad = record('Invalid'); bad.requests = [{ ...validRequest(), collectionId: 'missing' }]
    assert.throws(() => writeWorkspace(bad), /collection reference/)
    assert.throws(() => restoreWorkspace(bad, [], 'light'), /collection reference/)
    assert.throws(() => write('tabs', [{ request: { id: 'bad' } }]), /Invalid workspace backup/)
    assert.equal(entries.get('reqdesk.workspace'), before)
  } finally { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous }
})

test('import preflight accepts valid merged workspaces and rejects cumulative count and byte limits without saving', () => {
  const previous = globalThis.localStorage, entries = new Map()
  globalThis.localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) }
  try {
    writeWorkspace(record())
    const before = entries.get('reqdesk.workspace'), initial = record()
    initial.requests = Array.from({ length: 10000 }, (_, i) => validRequest(`existing-${i}`))
    assert.doesNotThrow(() => validateWorkspaceUpdate(initial, [initial.requests[0]]))
    const merged = { ...initial, requests: [...initial.requests, validRequest('imported')] }
    assert.throws(() => validateWorkspaceUpdate(merged, [merged.requests.at(-1)]), /requests/)
    const body = 'x'.repeat(13 * 1024 * 1024), large = record()
    large.requests = [validRequest('large-one'), validRequest('large-two')].map(request => ({ ...request, bodyType: 'text', body }))
    assert.doesNotThrow(() => validateWorkspaceUpdate(large, [large.requests[0]]))
    const imported = { ...validRequest('large-import'), bodyType: 'text', body }
    assert.throws(() => validateWorkspaceUpdate({ ...large, requests: [...large.requests, imported] }, [large.requests[0], imported]), /50 (?:MB|MiB)/)
    assert.equal(entries.get('reqdesk.workspace'), before)
    assert.equal(initial.requests.length, 10000)
  } finally { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous }
})

test('desktop startup counts open draft bodies once when a valid native workspace is near its byte limit', async () => {
  const body = 'x'.repeat(13 * 1024 * 1024), stored = record()
  stored.requests = [validRequest('one'), validRequest('two')].map(request => ({ ...request, bodyType: 'text', body }))
  stored.tabs = [{ request: stored.requests[0] }]
  const text = JSON.stringify(stored)
  assert.ok(Buffer.byteLength(text) < 50 * 1024 * 1024)
  const store = createDesktopWorkspaceStore(async () => text, () => undefined, () => {})
  await store.initialize()
  assert.equal(store.get().tabs[0].request.body.length, body.length)
  assert.equal(store.get().requests.length, 2)
})

test('browser workspace saves and restores preserve arbitrary metadata with atomic quota behavior', () => {
  const previous = globalThis.localStorage, entries = new Map()
  let rejected = false
  globalThis.localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { if (rejected) throw new Error('Quota'); entries.set(key, value) } }
  try {
    writeWorkspace(record())
    write('updates', { endpoint: 'custom' }); write('navigationCollapsed', ['nested'])
    const edited = record('Edited')
    delete edited.theme; delete edited.tabs; delete edited.updates; delete edited.navigationCollapsed
    writeWorkspace(edited)
    assert.deepEqual(read('updates', {}), { endpoint: 'custom' })
    write('updates', { endpoint: 'retained' })
    const data = { collections: [], requests: [], environments: [], environmentId: '', cookies: [], history: [], trash: { requests: [], collections: [] } }
    const before = new Map(entries); rejected = true
    assert.throws(() => restoreWorkspace(data, [], 'light'), /Quota/)
    assert.deepEqual(entries, before)
    rejected = false; restoreWorkspace(data, [], 'light')
    assert.deepEqual(read('updates', {}), { endpoint: 'retained' })
    assert.deepEqual(read('navigationCollapsed', []), ['nested'])
  } finally { if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous }
})
