import { useEffect, useRef, useState } from 'react'
import type { Collection, Cookie, Environment, History, Method, OAuth, Pair, Request, RequestJournalEntry, WorkspaceData } from './types/request'
import { read, restoreWorkspace, validateWorkspaceUpdate, writeWorkspace } from './storage/database'
import { RequestValidationError, sendRequest } from './services/httpClient'
import './App.css'
import './theme.css'
import './features.css'
import { isTauri } from '@tauri-apps/api/core'
import { importPostman } from './services/postmanImport'
import type { ImportResult } from './services/postmanImport'
import { Sidebar } from './components/Sidebar'
import { Modal } from './components/Modal'
import { PairEditor } from './components/PairEditor'
import { ResponsePanel } from './components/ResponsePanel'
import { RequestJournal } from './components/RequestJournal'
import { OpenApiImport } from './components/OpenApiImport'
import { SchemaEditor } from './components/SchemaEditor'
import { validateResponseSchema } from './services/schemaValidation'
import { completeJournal } from './services/requestJournal'
import { WorkspaceTools } from './components/WorkspaceTools'
import { BodyEditor, TestsEditor } from './components/RequestExtras'
import { AuthEditor } from './components/AuthEditor'
import { CollectionRunner } from './components/CollectionRunner'
import { FolderEditor } from './components/FolderEditor'
import { ThemeControl } from './components/ThemeControl'
import { captureCookies, checkResponse } from './services/workspace'
import { useRequestTabs } from './hooks/useRequestTabs'
import { TemplateEditor } from './components/TemplateEditor'
import { CaptureDialog, CaptureEditor } from './components/CaptureEditor'
import { RequestSettings } from './components/RequestSettings'
import { importCurl, exportCurl } from './services/curl'
import { appendHistory, captureVariables } from './services/responseData'
import { authMode, withCollectionAuth, requestTimeout } from './services/requestOptions'
import { prepareRequestUrl } from './services/prepareRequest'
import { changeRequestParams, changeRequestUrl, normalizeRequestQuery } from './services/queryParams'
import type { WorkspaceBackup } from './services/backup'
import { applyTheme } from './theme'
import { moveRequestFolder, planFolderMove } from './services/folderMoves'
import { buildFolderTree, flattenFolderTree, moveRequestOrder, moveCollectionOrder } from './services/navigation'
import type { RunnerScenario } from './services/runnerScenarios'
import { OAuthTokenManager, oauthIdentity, receivedToken, resolveOAuth, tokenRequest } from './services/oauth'
import { authorizeOAuth } from './services/oauthDesktop'
import { DesktopSettings } from './components/DesktopSettings'
import { APP_VERSION } from './version'
import { mergeDeletedItems, normalizeTrash, renewedOAuth, upsertSavedRequest } from './services/appState'
const id = () => crypto.randomUUID()
const blank = (collectionId: string): Request => ({ id: id(), collectionId, name: 'Untitled request', method: 'GET', url: '', params: [], headers: [], bodyType: 'none', body: '' })
const initial: Request[] = [
  { ...blank('demo'), id: 'users', name: 'Get all users', url: 'https://jsonplaceholder.typicode.com/users', headers: [{ id: 'accept', key: 'Accept', value: 'application/json', enabled: true }] },
  { ...blank('demo'), id: 'user', name: 'Get a user', url: 'https://jsonplaceholder.typicode.com/users/1' },
  { ...blank('demo'), id: 'create', name: 'Create a user', method: 'POST', url: 'https://jsonplaceholder.typicode.com/users', bodyType: 'json', body: '{\n  "name": "Alex Morgan",\n  "email": "alex@example.com"\n}' },
  { ...blank('demo'), id: 'update', name: 'Update a user', method: 'PATCH', url: 'https://jsonplaceholder.typicode.com/users/1', bodyType: 'json', body: '{\n  "name": "Alex Morgan"\n}' },
  { ...blank('demo'), id: 'delete', name: 'Delete a user', method: 'DELETE', url: 'https://jsonplaceholder.typicode.com/users/1' },
]
function App() {
  const [collections, setCollections] = useState<Collection[]>(() => read('collections', [{ id: 'demo', name: 'Demo API' }]))
  const [requests, setRequests] = useState<Request[]>(() => read('requests', initial))
  const [history, setHistory] = useState<History[]>(() => read('history', []))
  const [trash, setTrash] = useState<{ requests: Request[]; collections: Collection[] }>(() => normalizeTrash(read('trash', { requests: [], collections: [] })))
  const [environments, setEnvironments] = useState<Environment[]>(() => read('environments', []))
  const [environmentId, setEnvironmentId] = useState<string>(() => read('environmentId', ''))
  const [cookies, setCookies] = useState<Cookie[]>(() => read('cookies', []))
  const [runnerScenarios, setRunnerScenarios] = useState<RunnerScenario[]>(() => read('runnerScenarios', []))
  const oauthTokens = useRef(new OAuthTokenManager())
  const cookieJar = useRef(cookies)
  const [showTools, setShowTools] = useState(false)
  const [showRunner, setShowRunner] = useState(false)
  const [showOpenApi, setShowOpenApi] = useState(false)
  const [showJournal, setShowJournal] = useState(false)
  const [showDesktopSettings, setShowDesktopSettings] = useState(false)
  const [networkLogs, setNetworkLogs] = useState<RequestJournalEntry[]>([])
  const [section, setSection] = useState('Collections')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState('')
  const tabs = useRequestTabs(requests[0] ?? blank(collections[0]?.id ?? ''), setNotice)
  const { request: draft, response, assertions: assertionResults, error, editor: tab, view, search: responseSearch, match: matchIndex } = tabs.active
  const setDraft = tabs.field('request'), setResponse = tabs.field('response'), setAssertionResults = tabs.field('assertions'), setError = tabs.field('error'), setBusy = tabs.field('busy'), setTab = tabs.field('editor'), setView = tabs.field('view'), setResponseSearch = tabs.field('search'), setMatchIndex = tabs.field('match')
  const [runnerBusy, setRunnerBusy] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const busy = runnerBusy || attachmentBusy || tabs.active.busy
  const anyBusy = runnerBusy || attachmentBusy || tabs.tabs.some(t => t.busy)
  const [closingTab, setClosingTab] = useState<string | null>(null)
  const [showCapture, setShowCapture] = useState(false)
  const [showCurl, setShowCurl] = useState(false)
  const [curlText, setCurlText] = useState(''), [curlError, setCurlError] = useState('')
  const [curlPreview, setCurlPreview] = useState<Request | null>(null)
  const [curlCollection, setCurlCollection] = useState('')
  const [curlExport, setCurlExport] = useState<string | null>(null)
  const [themeKey, setThemeKey] = useState(0)
  const [collectionForm, setCollectionForm] = useState<(Collection & { moves?: Record<string, string> }) | null>(null)
  const [newRequest, setNewRequest] = useState<Request | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'request' | 'collection'; id: string; name: string } | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null)
  const [importError, setImportError] = useState('')
  const [importLoading, setImportLoading] = useState(false)
  const importRead = useRef(0)
  const controllers = useRef(new Map<string, AbortController>())
  const environmentRef = useRef<Environment | undefined>(environments.find(e => e.id === environmentId))
  useEffect(() => { environmentRef.current = environments.find(e => e.id === environmentId) }, [environments, environmentId])
  useEffect(() => { try { writeWorkspace({ collections, requests, history, trash, environments, environmentId, cookies, runnerScenarios }) } catch { queueMicrotask(() => setNotice('Changes could not be saved. Download a workspace backup.')) } }, [collections, requests, history, trash, environments, environmentId, cookies, runnerScenarios])
  useEffect(() => { const onError = (event: Event) => setNotice((event as CustomEvent<string>).detail || 'Changes could not be saved. Download a workspace backup.'); window.addEventListener('reqmas-storage-error', onError); return () => window.removeEventListener('reqmas-storage-error', onError) }, [])
  const environment = environments.find(e => e.id === environmentId)
  const update = (change: Partial<Request> | ((current: Request) => Partial<Request>)) => setDraft(d => ({ ...d, ...(typeof change === 'function' ? change(d) : change) }))
  const saved = requests.find(r => r.id === draft.id)
  const isDirty = (request: Request) => { const stored = requests.find(r => r.id === request.id); return stored ? JSON.stringify(normalizeRequestQuery(stored)) !== JSON.stringify(normalizeRequestQuery(request)) : JSON.stringify({ ...request, id: '', collectionId: '' }) !== JSON.stringify({ ...blank(''), id: '', collectionId: '' }) }
  const dirty = isDirty(draft)
  const persist = (request: Request) => setRequests(rs => upsertSavedRequest(rs, request))
  const openRequest = (request: Request) => {
    tabs.open(request); setNotice('')
  }
  const select = (request: Request, shouldPersist = false) => {
    if (!collections.some(c => c.id === request.collectionId)) request = { ...request, collectionId: collections[0]?.id ?? '' }
    if (shouldPersist) persist(request)
    openRequest(request)
  }
  const save = () => {
    if (!draft.name.trim()) { setNotice('Enter a request name before saving.'); return false }
    if (!collections.some(c => c.id === draft.collectionId)) { setNotice('Choose or create a collection before saving.'); return false }
    const request = { ...draft, name: draft.name.trim() }
    persist(request); setDraft(request); setNotice(saved ? 'Request updated' : 'Request added'); return true
  }
  const editCollection = (c: Collection) => setCollectionForm({ ...structuredClone(c), folders: flattenFolderTree(buildFolderTree(c.folders ?? [], [...requests, ...tabs.tabs.map(t => t.request)].filter(r => r.collectionId === c.id))) })
  const createRequest = (collectionId?: string) => setNewRequest(blank(collectionId ?? (collections.some(c => c.id === draft.collectionId) ? draft.collectionId : collections[0]?.id ?? '')))
  const moveRequest = (requestId: string, collectionId: string, folder: string, beforeRequestId?: string) => {
    if (anyBusy || !collections.some(c => c.id === collectionId)) return
    setRequests(current => moveRequestOrder(current, requestId, collectionId, folder, beforeRequestId))
    tabs.setTabs(all => all.map(t => t.request.id === requestId ? { ...t, request: { ...t.request, collectionId, folder: folder || undefined } } : t))
  }
  const closeTab = (tabId: string) => { const t = tabs.tabs.find(t => t.id === tabId); if (!t || t.busy) return; if (isDirty(t.request)) setClosingTab(tabId); else tabs.close(tabId, requests[0] ?? blank(collections[0]?.id ?? '')) }
  const finishClose = (saveChanges: boolean) => { const t = tabs.tabs.find(t => t.id === closingTab); if (!t) return; let nextRequests = requests; if (saveChanges) { if (!t.request.name.trim() || !collections.some(c => c.id === t.request.collectionId)) { setNotice('Choose a collection and enter a request name before saving.'); return } const savedRequest = { ...t.request, name: t.request.name.trim() }; nextRequests = upsertSavedRequest(requests, savedRequest); persist(savedRequest) } tabs.close(t.id, nextRequests[0] ?? blank(collections[0]?.id ?? '')); setClosingTab(null) }
  const remove = () => {
    if (!deleteTarget) return
    const deletingCollection = deleteTarget.kind === 'collection'
    const remaining = requests.filter(r => deletingCollection ? r.collectionId !== deleteTarget.id : r.id !== deleteTarget.id)
    const remainingCollections = deletingCollection ? collections.filter(c => c.id !== deleteTarget.id) : collections
    setTrash(t => ({ requests: mergeDeletedItems(t.requests, requests.filter(r => deletingCollection ? r.collectionId === deleteTarget.id : r.id === deleteTarget.id)), collections: deletingCollection ? mergeDeletedItems(t.collections, collections.filter(c => c.id === deleteTarget.id)) : t.collections }))
    setRequests(remaining); setCollections(remainingCollections)
    const keep = tabs.tabs.filter(t => deletingCollection ? t.request.collectionId !== deleteTarget.id : t.request.id !== deleteTarget.id)
    if (keep.length) tabs.setTabs(keep); else tabs.reset([remaining[0] ?? blank(remainingCollections[0]?.id ?? '')])
    setDeleteTarget(null); setNotice(deletingCollection ? 'Collection deleted' : 'Request deleted')
  }
  const restoreDeleted = () => {
    const deleted = normalizeTrash(trash)
    setCollections(cs => [...cs, ...deleted.collections.filter(c => !cs.some(existing => existing.id === c.id))])
    setRequests(rs => [...rs, ...deleted.requests.filter(r => !rs.some(existing => existing.id === r.id))])
    setTrash({ requests: [], collections: [] }); setNotice('Deleted items restored')
  }
  const previewImport = (text: string) => { setImportText(text); setImportError(''); setImportPreview(null); try { setImportPreview(importPostman(text)) } catch (e) { setImportError(e instanceof Error ? e.message : 'Could not read collection.') } }
  const loadPostmanFile = async (file?: File) => {
    if (!file) return
    const read = ++importRead.current
    setImportPreview(null); setImportError('')
    if (file.size > 50 * 1024 * 1024) { setImportLoading(false); setImportError('Collection file is larger than 50 MiB.'); return }
    setImportLoading(true)
    try { const text = await file.text(); if (read === importRead.current) previewImport(text) }
    catch { if (read === importRead.current) setImportError('Could not read this file.') }
    finally { if (read === importRead.current) setImportLoading(false) }
  }
  const closeImport = () => { importRead.current++; setImportLoading(false); setShowImport(false) }
  const confirmImport = () => {
    if (!importPreview) return
    try { validateWorkspaceUpdate({ ...workspaceData, collections: [...collections, importPreview.collection], requests: [...requests, ...importPreview.requests] }, [...tabs.tabs.map(t => t.request), ...importPreview.requests.slice(0, 1)]) }
    catch (error) { setImportError(error instanceof Error ? error.message : String(error)); return }
    setCollections(cs => [...cs, importPreview.collection]); setRequests(rs => [...rs, ...importPreview.requests]); setSection('Collections'); setSearch('')
    if (importPreview.requests[0]) openRequest(importPreview.requests[0])
    setNotice(`Imported ${importPreview.requests.length} requests; skipped ${importPreview.skipped}.`); setShowImport(false)
  }
  const sendTraced = async (snapshot: Request, signal: AbortSignal, iterationVariables: Pair[] = []) => {
    const log: RequestJournalEntry = { id: id(), name: snapshot.name, startedAt: new Date().toISOString(), transport: isTauri() ? 'desktop' : 'browser', state: 'sending' }
    const started = performance.now()
    setNetworkLogs(logs => [log, ...logs].slice(0, 50))
    const collection = collections.find(c => c.id === snapshot.collectionId)
    try {
      let effective = withCollectionAuth(snapshot, collection)
      if (effective.oauth?.autoRefresh) {
        const config = effective.oauth
        const oauth = resolveOAuth(config, [...(collection?.variables ?? []), ...(environmentRef.current?.variables ?? []), ...iterationVariables, ...(snapshot.variables ?? [])])
        const refreshed = await oauthTokens.current.ensure(oauthIdentity(oauth), oauth, signal, async current => {
          if (current.flow === 'authorization_code' && !current.refreshToken) throw new RequestValidationError('OAuth sign-in is required. Open Auth and use Get access token before sending.')
          const request = tokenRequest(snapshot, current, current.refreshToken ? { refresh: current.refreshToken } : undefined)
          if (isTauri()) request.followRedirects = false
          return receivedToken(current, await sendTraced(request, signal, iterationVariables))
        })
        effective = { ...effective, oauth: refreshed }
        if (refreshed.accessToken !== oauth.accessToken || refreshed.expiresAt !== oauth.expiresAt) publishToken(snapshot, config, refreshed, undefined, oauth)
      }
      const result = await sendRequest(effective, signal, collection?.variables ?? [], [...(environmentRef.current?.variables ?? []), ...iterationVariables], cookieJar.current, prepared => setNetworkLogs(logs => logs.map(entry => entry.id === log.id ? { ...entry, request: prepared } : entry)))
      signal.throwIfAborted()
      setNetworkLogs(logs => logs.map(entry => entry.id === log.id ? completeJournal(entry, result) : entry))
      return result
    } catch (error) {
      setNetworkLogs(logs => logs.map(entry => entry.id === log.id ? { ...entry, state: 'failed', duration: Math.round(performance.now() - started), error: signal.aborted ? 'Request cancelled or timed out' : error instanceof Error ? error.message : String(error) } : entry))
      throw error
    }
  }
  const publishToken = (source: Request, config: OAuth, next: OAuth, targetTabId?: string, accountSource?: OAuth) => {
    const oauth = { ...config, accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt }
    if (targetTabId) {
      tabs.setTabs(all => all.map(t => t.id === targetTabId ? { ...t, request: { ...t.request, authMode: 'oauth', oauth } } : t))
      return
    }
    // Automatic renewal preserves inheritance and any edits made in another tab.
    const renew = (current: OAuth, variables: Pair[]) => accountSource ? renewedOAuth(current, config, next, accountSource, variables, oauthTokens.current) : current
    if (authMode(source) === 'inherit') {
      setCollections(all => all.map(c => {
        if (c.id !== source.collectionId || !c.oauth) return c
        const renewed = renew(c.oauth, [...(c.variables ?? []), ...(environmentRef.current?.variables ?? [])])
        return renewed === c.oauth ? c : { ...c, oauth: renewed }
      }))
    } else {
      const apply = (r: Request) => {
        if (r.id !== source.id || authMode(r) !== 'oauth' || !r.oauth) return r
        const parent = collections.find(c => c.id === r.collectionId)
        const renewed = renew(r.oauth, [...(parent?.variables ?? []), ...(environmentRef.current?.variables ?? []), ...(r.variables ?? [])])
        return renewed === r.oauth ? r : { ...r, oauth: renewed }
      }
      tabs.setTabs(all => all.map(t => ({ ...t, request: apply(t.request) })))
      setRequests(all => all.map(apply))
    }
  }
  const execute = async (snapshot: Request, signal: AbortSignal, iterationVariables: Pair[] = []) => {
    const activeEnvironment = environmentRef.current
    const result = await sendTraced(snapshot, signal, iterationVariables)
    signal.throwIfAborted()
    if (result.setCookies?.length && result.url) { cookieJar.current = captureCookies(result.url, result.setCookies, cookieJar.current); setCookies(cookieJar.current) }
    const captureEnvironment = environmentRef.current?.id === activeEnvironment?.id ? environmentRef.current : undefined
    const captured = captureVariables(snapshot.extractions ?? [], result, captureEnvironment)
    if (captured.variables && captureEnvironment) { const next = { ...captureEnvironment, variables: captured.variables }; environmentRef.current = next; setEnvironments(es => es.map(e => e.id === next.id ? next : e)) }
    const complete = { ...result, captures: captured.results }
    setHistory(h => appendHistory({ id: id(), request: structuredClone(snapshot), response: complete, time: new Date().toISOString(), status: result.status, duration: result.duration }, h))
    return complete
  }
  const getToken = async () => {
    const snapshot = structuredClone(draft)
    const source = withCollectionAuth(snapshot, collections.find(c => c.id === snapshot.collectionId)).oauth; if (!source) return
    let oauth: OAuth
    try { oauth = resolveOAuth(source, variables) } catch (err) { setError(err instanceof Error ? err.message : String(err)); return }
    const tabId = tabs.active.id
    const abort = new AbortController(); controllers.current.set(tabId, abort); setBusy(true); setError('')
    const timeoutMs = oauth.flow === 'authorization_code' ? 150000 : requestTimeout(snapshot)
    let timedOut = false
    const timer = setTimeout(() => { if (!abort.signal.aborted) { timedOut = true; abort.abort() } }, timeoutMs)
    try {
      const next = await oauthTokens.current.ensure(oauthIdentity(oauth), oauth, abort.signal, async current => {
        const grant = current.flow === 'authorization_code' ? await authorizeOAuth(current, abort.signal) : undefined
        const request = tokenRequest(snapshot, current, grant)
        if (isTauri()) request.followRedirects = false
        return receivedToken(current, await sendTraced(request, abort.signal))
      }, true)
      publishToken(snapshot, source, next, tabId); setNotice('OAuth token received for this request. Save request to keep it.')
    } catch (e) { setError(abort.signal.aborted ? timedOut ? `Token request timed out after ${timeoutMs / 1000} seconds.` : 'Token request cancelled.' : String(e)) }
    finally { clearTimeout(timer); setBusy(false); controllers.current.delete(tabId) }
  }
  const send = async () => {
    const snapshot = structuredClone(draft)
    const tabId = tabs.active.id
    const abort = new AbortController(); controllers.current.set(tabId, abort)
    setBusy(true); setError(''); setResponse(null); setAssertionResults([]); tabs.field('historyNote')('')
    const timeoutMs = requestTimeout(snapshot)
    let timedOut = false
    const timer = setTimeout(() => { if (!abort.signal.aborted) { timedOut = true; abort.abort() } }, timeoutMs)
    try {
      const result = await execute(snapshot, abort.signal)
      setResponse(result); setAssertionResults([...checkResponse(snapshot.tests ?? [], result), ...validateResponseSchema(snapshot.responseSchema ?? '', result), ...(result.captures ?? [])])

    } catch (e) { setError(e instanceof RequestValidationError ? e.message : abort.signal.aborted ? timedOut ? `Request timed out after ${timeoutMs / 1000} seconds.` : 'Request cancelled.' : `${e instanceof Error ? e.message : String(e)}. Check the URL and network.${isTauri() ? '' : ' The API must allow browser requests (CORS).'}`) }
    finally { clearTimeout(timer); setBusy(false); controllers.current.delete(tabId) }
  }
  const workspaceData: WorkspaceData = { collections, requests, environments, environmentId, cookies, history, trash, runnerScenarios }
  const restoreBackup = async (backup: WorkspaceBackup) => {
    const d = backup.data
    const drafts = (backup.drafts.length ? backup.drafts : [d.requests[0] ?? blank(d.collections[0]?.id ?? '')]).map(normalizeRequestQuery)
    await restoreWorkspace(d, drafts, backup.theme)
    oauthTokens.current.clear(); setRunnerScenarios(d.runnerScenarios ?? [])
    setCollections(d.collections); setRequests(d.requests); setEnvironments(d.environments); setEnvironmentId(d.environmentId); setHistory(d.history); setTrash(d.trash); setCookies(d.cookies); cookieJar.current = d.cookies
    environmentRef.current = d.environments.find(e => e.id === d.environmentId); tabs.reset(drafts); applyTheme(backup.theme); setThemeKey(n => n + 1); setShowTools(false); setNotice('Workspace restored')
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.repeat || event.isComposing || document.querySelector('dialog[open]')) return
      if (event.key.toLowerCase() === 'k') { event.preventDefault(); const input = document.querySelector<HTMLInputElement>('[data-request-search]'); input?.focus(); input?.select() }
      else if (event.key.toLowerCase() === 's') { event.preventDefault(); if (!busy) save() }
      else if (event.key === 'Enter') { event.preventDefault(); if (!busy) void send() }
    }
    document.addEventListener('keydown', shortcut); return () => document.removeEventListener('keydown', shortcut)
  })
  const saveResponseVariable = (key: string, value: string) => { const env = environmentRef.current; if (!env) return; const existing = env.variables.find(v => v.key === key); const variables = env.variables.filter(v => v.key !== key); variables.push({ id: existing?.id ?? id(), key, value, enabled: true, ...(existing?.secret ? { secret: true } : {}) }); const next = { ...env, variables }; environmentRef.current = next; setEnvironments(es => es.map(e => e.id === env.id ? next : e)); setNotice(`Saved ${key} to ${env.name}`) }
  const collection = collections.find(c => c.id === draft.collectionId)
  const variables = [...(collection?.variables ?? []), ...(environment?.variables ?? []), ...(draft.variables ?? [])]
  let resolvedUrl = ''
  try { resolvedUrl = prepareRequestUrl(draft, variables).toString() } catch { /* The editor shows unresolved templates until all values exist. */ }
  const rows = tab === 'Params' ? draft.params : tab === 'Variables' ? draft.variables ?? [] : draft.headers
  const setRows = (next: Pair[]) => update(tab === 'Params' ? changeRequestParams(draft, next) : tab === 'Variables' ? { variables: next } : { headers: next })
  return <div className="app">
    <Sidebar collections={collections} requests={requests} history={history} selectedId={draft.id} section={section} search={search} busy={anyBusy}
      onSection={setSection} onSearch={setSearch} onSelect={select} onNew={createRequest}
      onHistory={h => { tabs.open(h.request, h.response ? { ...h.response, bodyTruncated: h.bodyTruncated || h.response.bodyTruncated } : undefined, `History · ${new Date(h.time).toLocaleString()}${h.bodyTruncated ? ' · body truncated to fit local storage' : h.response ? '' : ' · this older entry has no saved response'}`) }}
      onDelete={r => setDeleteTarget({ kind: 'request', id: r.id, name: r.name })}
      onCollection={c => setCollectionForm(c ? { ...structuredClone(c), folders: Array.from(new Set([...(c.folders ?? []), ...requests.filter(r => r.collectionId === c.id).map(r => r.folder ?? '')].filter(Boolean))) } : { id: id(), name: '', variables: [] })}
      onImport={() => { importRead.current++; setImportLoading(false); setShowImport(true); setImportText(''); setImportPreview(null); setImportError('') }} onOpenApi={() => setShowOpenApi(true)} onClearHistory={() => setHistory([])} onMoveRequest={moveRequest} onMoveCollection={(collectionId, beforeCollectionId) => { if (!anyBusy) setCollections(current => moveCollectionOrder(current, collectionId, beforeCollectionId)) }} />
    <main>
      <header className="topbar"><div><span className="muted">Workspace</span><span className="slash">/</span>{collection?.name ?? 'New request'}</div><div className="workspace-actions"><ThemeControl key={themeKey} /><select aria-label="Active environment" disabled={anyBusy} value={environment?.id ?? ''} onChange={e => { setEnvironmentId(e.target.value) }}><option value="">No environment</option>{environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select><button className="save" disabled={anyBusy} onClick={() => setShowTools(true)} title="Environments, export, backup and cookies">⚙ Workspace</button><button className="save" disabled={anyBusy || !collections.length} onClick={() => setShowRunner(true)}>▶ Runner</button><button className="save" disabled={anyBusy} onClick={() => setShowDesktopSettings(true)} title="Storage backups and signed updates">App settings</button><button className="save" onClick={() => setShowJournal(true)}>Request log <span className="count">{networkLogs.length}</span></button><span className="browser-badge">◉ {isTauri() ? 'Desktop mode' : 'Browser mode'}</span></div></header>
      <div className="open-tabs request-tabs" role="tablist" aria-label="Open requests">{tabs.tabs.map(t => <div className={`request-tab ${tabs.active.id === t.id ? 'active' : ''}`} key={t.id}><button role="tab" disabled={attachmentBusy} aria-selected={tabs.active.id === t.id} aria-label={`Open ${t.request.name}`} onClick={() => tabs.setActiveId(t.id)}><span className={`method ${t.request.method.toLowerCase()}`}>{t.request.method}</span><span>{t.request.name}</span>{t.busy ? <span className="tab-spinner">◌</span> : isDirty(t.request) && <span className="dirty-dot" />}{t.historyNote && <span title="History snapshot">◷</span>}</button><button className="close-tab" disabled={t.busy || runnerBusy || attachmentBusy} aria-label={`Close ${t.request.name}`} onClick={() => closeTab(t.id)}>×</button></div>)}<button className="add-tab" disabled={runnerBusy || attachmentBusy} aria-label="New request tab" onClick={() => tabs.open(blank(collection?.id ?? collections[0]?.id ?? ''))}>+</button></div>
      <div className="editor">
        <div className="request-heading"><div><div className="eyebrow">REQUEST</div><input disabled={busy} className="request-name" aria-label="Request name" value={draft.name} onChange={e => update({ name: e.target.value })} /><p>Build, send, and inspect your API requests.</p></div><button className="save" disabled={busy} onClick={save}>▣ <span>Save request</span>{dirty && <span className="shortcut">●</span>}</button></div>
        <div className="request-actions">
          <label>Collection <select aria-label="Request collection" disabled={busy} value={draft.collectionId} onChange={e => update({ collectionId: e.target.value, folder: '' })}><option value="" disabled>Choose a collection</option>{collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Folder <select aria-label="Request folder" disabled={busy} value={draft.folder ?? ''} onChange={e => update({ folder: e.target.value })}><option value="">Collection root</option>{flattenFolderTree(buildFolderTree(collection?.folders ?? [], [...requests.filter(r => r.collectionId === draft.collectionId), draft])).map(f => <option key={f} value={f}>{f}</option>)}</select></label>
          <div><button className="save" disabled={anyBusy || !collections.length} onClick={() => { setCurlCollection(draft.collectionId || collections[0]?.id || ''); setCurlText(''); setCurlError(''); setCurlPreview(null); setShowCurl(true) }}>Import cURL</button><button className="save" disabled={busy} onClick={() => { try { setCurlExport(exportCurl(withCollectionAuth(draft, collection), collection?.variables, environment?.variables)) } catch (e) { setNotice(String(e)) } }}>Copy as cURL</button><button className="save" disabled={busy || !collections.length} onClick={() => select({ ...structuredClone(draft), id: id(), name: draft.name + ' (copy)' }, true)}>Duplicate</button><button className="save danger-text" disabled={anyBusy || !saved} onClick={() => setDeleteTarget({ kind: 'request', id: draft.id, name: draft.name })}>Delete</button></div>
        </div>
        <form className="url-bar" onSubmit={e => { e.preventDefault(); if (!busy) void send() }}><select disabled={busy} aria-label="HTTP method" className={draft.method.toLowerCase()} value={draft.method} onChange={e => update({ method: e.target.value as Method })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(m => <option key={m}>{m}</option>)}</select><TemplateEditor disabled={busy} label="Request URL" placeholder="https://api.example.com" value={draft.url} onChange={url => update(changeRequestUrl(draft, url))} variables={variables} /><button className="send" disabled={runnerBusy || attachmentBusy} type={tabs.active.busy ? 'button' : 'submit'} onClick={tabs.active.busy ? e => { e.preventDefault(); controllers.current.get(tabs.active.id)?.abort() } : undefined}>{tabs.active.busy ? 'Cancel' : 'Send request'} <span>{tabs.active.busy ? '×' : '↗'}</span></button></form>
        {resolvedUrl && draft.url.includes('{{') && <details className="resolved-url"><summary>Resolved URL</summary><code>{resolvedUrl}</code></details>}
        <div className="editor-tabs">{['Params', 'Headers', 'Body', 'Auth', 'Variables', 'Tests', 'Schema', 'Capture', 'Settings'].map(t => <button className={tab === t ? 'active' : ''} key={t} onClick={() => setTab(t)}>{t}{['Params', 'Headers'].includes(t) && <span className="count">{(t === 'Params' ? draft.params : draft.headers).filter(p => p.key && p.enabled).length}</span>}{t === 'Body' && draft.bodyType !== 'none' && <span className="dirty-dot" />}</button>)}<span className="tab-caption">Configure your request</span></div>
        <section className="request-config">{tab === 'Body' ? <BodyEditor key={tabs.active.id} onReading={setAttachmentBusy} request={draft} update={update} busy={busy} onError={setNotice} variables={variables} /> : tab === 'Auth' ? <AuthEditor request={draft} update={update} busy={busy} inherited={collection} browserCookies={draft.browserCookies} onBrowserCookies={browserCookies => update({ browserCookies })} onToken={() => void getToken()} /> : tab === 'Tests' ? <TestsEditor tests={draft.tests ?? []} onChange={tests => update({ tests })} disabled={busy} /> : tab === 'Schema' ? <SchemaEditor schema={draft.responseSchema ?? ''} onChange={responseSchema => update({ responseSchema })} disabled={busy} inferredSample={response?.binary ? undefined : response?.body} /> : tab === 'Capture' ? <CaptureEditor rules={draft.extractions ?? []} onChange={extractions => update({ extractions })} disabled={busy} /> : tab === 'Settings' ? <RequestSettings request={draft} update={update} disabled={busy} desktop={isTauri()} /> : <>
          <div className="config-title">{tab === 'Params' ? 'Query parameters' : tab === 'Variables' ? 'Request variables' : 'Request headers'}<span>Enable only what you need</span></div>
          <PairEditor rows={rows} allowSecrets={tab === 'Variables'} onChange={setRows} disabled={busy} label={tab === 'Params' ? 'parameter' : tab === 'Variables' ? 'variable' : 'header'} />
          <p className="config-hint">{tab === 'Params' ? 'Query parameters stay in sync with the URL. Disabled parameters are kept here and excluded from the request.' : tab === 'Variables' ? 'Use {{variable}} in URL, headers, params, body or auth. Priority: collection → environment → request.' : 'Add Authorization or other headers your API requires.'}</p>
          {tab === 'Variables' && <button className="save" disabled={anyBusy} onClick={() => { const c = collections.find(c => c.id === draft.collectionId); if(c) editCollection(c) }}>Edit collection variables ({collections.find(c => c.id === draft.collectionId)?.variables?.length ?? 0})</button>}
        </>}</section>
        {(response || tabs.active.historyNote) && <div className="response-history"><span>{tabs.active.historyNote || 'Response from this request tab'}</span>{response && <button className="save" disabled={anyBusy} onClick={() => setShowCapture(true)}>Save value to environment</button>}</div>}
        <ResponsePanel key={tabs.active.id} response={response} error={error} busy={busy} assertions={assertionResults} history={history} comparisonResponses={tabs.tabs.filter(t => t.id !== tabs.active.id && t.response).map(t => ({ id: t.id, name: t.request.name, response: t.response! }))} view={view} onView={setView} search={responseSearch} onSearch={value => { setResponseSearch(value); setMatchIndex(0) }} match={matchIndex} onMatch={setMatchIndex} onNotice={setNotice} />
      </div>
      <footer><span><span className="local-dot" /> {busy ? 'Sending request' : 'Ready'} <span className="footer-divider">|</span> {notice || 'Collections and history saved locally'}{(trash.requests.length > 0 || trash.collections.length > 0) && <button className="restore-deleted" disabled={busy} onClick={restoreDeleted}>Restore deleted</button>}</span><span>Reqmas <span className="muted">v{APP_VERSION}</span></span></footer>
    </main>
    {showTools && <WorkspaceTools data={workspaceData} drafts={tabs.tabs.map(t => t.request)} onRestore={restoreBackup} environments={environments} collections={collections} requests={requests} cookies={cookies} desktop={isTauri()} onEnvironments={es => { setEnvironments(es); if (!es.some(e => e.id === environmentId)) setEnvironmentId('') }} onCookies={cs => { setCookies(cs); cookieJar.current = cs }} onClose={() => setShowTools(false)} />}
    {showDesktopSettings && <DesktopSettings data={workspaceData} drafts={tabs.tabs.map(t => t.request)} onRestore={restoreBackup} onClose={() => setShowDesktopSettings(false)} />}
    {showOpenApi && <OpenApiImport onClose={() => setShowOpenApi(false)} onImport={result => { validateWorkspaceUpdate({ ...workspaceData, collections: [...collections, result.collection], requests: [...requests, ...result.requests] }, [...tabs.tabs.map(t => t.request), ...result.requests.slice(0, 1)]); setCollections(all => [...all, result.collection]); setRequests(all => [...all, ...result.requests]); if (result.requests[0]) openRequest(result.requests[0]); setSection('Collections'); setSearch(''); setShowOpenApi(false); setNotice(`Imported ${result.requests.length} OpenAPI requests; skipped ${result.skipped}.`) }} />}
    {showJournal && <RequestJournal entries={networkLogs} onClose={() => setShowJournal(false)} />}
    {showRunner && <CollectionRunner collections={collections} requests={requests} environmentName={environment?.name ?? ''} scenarios={runnerScenarios} onScenarios={setRunnerScenarios} initialCollectionId={draft.collectionId} onExecute={execute} onBusy={setRunnerBusy} onClose={() => setShowRunner(false)} />}
    {collectionForm && <Modal title={collections.some(c => c.id === collectionForm.id) ? 'Collection settings' : 'New collection'} onClose={() => setCollectionForm(null)} wide>
      <form onSubmit={e => { e.preventDefault(); if (!collectionForm.name.trim()) return; const { moves, ...form } = collectionForm; const c = { ...form, name: form.name.trim() }; if (moves) { const move = (r: Request) => moveRequestFolder(r, c.id, moves); setRequests(rs => rs.map(move)); tabs.setTabs(all => all.map(t => ({ ...t, request: move(t.request) }))) } setCollections(cs => cs.some(old => old.id === c.id) ? cs.map(old => old.id === c.id ? c : old) : [...cs, c]); setCollectionForm(null); setNotice('Collection saved') }}>
        <label>Collection name<input autoFocus aria-label="Collection name" required value={collectionForm.name} onChange={e => setCollectionForm({ ...collectionForm, name: e.target.value })} /></label>
        <FolderEditor folders={collectionForm.folders ?? []} onChange={folders => setCollectionForm({ ...collectionForm, folders })} onMove={(from, to) => {
          const paths = [...requests, ...tabs.tabs.map(t => t.request)].filter(r => r.collectionId === collectionForm.id).map(r => r.folder ?? '')
          setCollectionForm({ ...collectionForm, ...planFolderMove(collectionForm.folders ?? [], paths, collectionForm.moves ?? {}, from, to) })
        }} />
        <p>Collection variables · use {'{{variable}}'} in your requests.</p>
        <PairEditor allowSecrets rows={collectionForm.variables ?? []} label="collection variable" onChange={variables => setCollectionForm({ ...collectionForm, variables })} />
        <h3>Collection authentication</h3><AuthEditor request={collectionForm} collection update={change => setCollectionForm({ ...collectionForm, ...change })} />
        <div className="modal-actions">{collections.some(c => c.id === collectionForm.id) && <button type="button" className="save danger-text" onClick={() => { setDeleteTarget({ kind: 'collection', id: collectionForm.id, name: collectionForm.name }); setCollectionForm(null) }}>Delete collection</button>}<button type="button" className="save" onClick={() => setCollectionForm(null)}>Cancel</button><button type="submit" className="send">Save collection</button></div>
      </form>
    </Modal>}
    {newRequest && <Modal title="New request" onClose={() => setNewRequest(null)}>
      <form onSubmit={e => { e.preventDefault(); if(!newRequest.name.trim() || !collections.some(c => c.id === newRequest.collectionId)) return; select({ ...newRequest, name: newRequest.name.trim() }, true); setNewRequest(null) }}>
        <label>Request name<input autoFocus required aria-label="New request name" value={newRequest.name} onChange={e => setNewRequest({ ...newRequest, name: e.target.value })} /></label>
        <label>Collection<select aria-label="New request collection" required value={newRequest.collectionId} onChange={e => setNewRequest({ ...newRequest, collectionId: e.target.value })}><option value="" disabled>Choose a collection</option>{collections.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
        <label>Method<select aria-label="New request method" value={newRequest.method} onChange={e => setNewRequest({ ...newRequest, method: e.target.value as Method })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(m => <option key={m}>{m}</option>)}</select></label>
        <label>URL<input aria-label="New request URL" placeholder="https://api.example.com" value={newRequest.url} onChange={e => setNewRequest({ ...newRequest, url: e.target.value })} /></label>
        {!collections.length && <p>Create a collection using + in the sidebar first.</p>}
        <div className="modal-actions"><button type="button" className="save" onClick={() => setNewRequest(null)}>Cancel</button><button className="send" type="submit" disabled={!collections.length}>Create request</button></div>
      </form>
    </Modal>}
    {deleteTarget && <Modal title={deleteTarget.kind === 'collection' ? 'Delete collection?' : 'Delete request?'} onClose={() => setDeleteTarget(null)}>
      <p>Delete “{deleteTarget.name}”{deleteTarget.kind === 'collection' ? ' and all its saved requests' : ''}? Unsaved changes to the deleted request will be discarded. History is kept, and saved items can be restored using Restore deleted.</p>
      <div className="modal-actions"><button autoFocus className="save" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="danger-button" onClick={remove}>Confirm delete</button></div>
    </Modal>}
    {closingTab && <Modal title="Unsaved changes" onClose={() => setClosingTab(null)}>
      <p>Save changes to “{tabs.tabs.find(t => t.id === closingTab)?.request.name}” before closing its tab?</p><div className="modal-actions"><button autoFocus className="save" onClick={() => setClosingTab(null)}>Cancel</button><button className="save" onClick={() => finishClose(false)}>Discard and close</button><button className="send" onClick={() => finishClose(true)}>Save and close</button></div>
    </Modal>}
    {showCapture && response && <CaptureDialog response={response} environmentName={environment?.name ?? ''} onSave={saveResponseVariable} onClose={() => setShowCapture(false)} />}
    {showCurl && <Modal title="Import cURL" onClose={() => setShowCurl(false)} wide><p>Paste one cURL command. URL, method, headers, body, Basic Auth, cookies and timeout are imported. Commands are parsed as text.</p><label>Collection<select aria-label="cURL collection" value={curlCollection} onChange={e => { setCurlCollection(e.target.value); setCurlPreview(null) }}>{collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><textarea autoFocus className="import-text" aria-label="cURL command" value={curlText} onChange={e => { setCurlText(e.target.value); setCurlPreview(null); setCurlError('') }} placeholder="curl --location 'https://api.example.com/users'" /><button className="save" disabled={!curlText.trim()} onClick={() => { try { setCurlPreview(importCurl(curlText, curlCollection)); setCurlError('') } catch (e) { setCurlError(String(e)) } }}>Preview cURL</button>{curlError && <p role="alert" className="danger-text">{curlError}</p>}{curlPreview && <div className="import-preview"><label>Request name<input aria-label="cURL request name" value={curlPreview.name} onChange={e => setCurlPreview({ ...curlPreview, name: e.target.value })} /></label><p>{curlPreview.method} {curlPreview.url}</p><p>{curlPreview.headers.length} headers · {curlPreview.bodyType} body · {requestTimeout(curlPreview) / 1000}s timeout · redirects {curlPreview.followRedirects ? 'on' : 'off'}</p></div>}<div className="modal-actions"><button className="save" onClick={() => setShowCurl(false)}>Cancel</button><button className="send" disabled={!curlPreview?.name.trim()} onClick={() => { if (curlPreview) { try { validateWorkspaceUpdate({ ...workspaceData, requests: upsertSavedRequest(requests, curlPreview) }, [...tabs.tabs.map(t => t.request), curlPreview]) } catch (error) { setCurlError(error instanceof Error ? error.message : String(error)); return } select(curlPreview, true); setShowCurl(false); setNotice('cURL request imported') } }}>Import request</button></div></Modal>}
    {curlExport !== null && <Modal title="Copy as cURL" onClose={() => setCurlExport(null)} wide><p>Uses the current resolved values, including credentials. Run this command in a shell with POSIX quoting. For attached files, place the named files beside the command or edit their paths.</p><textarea className="import-text" aria-label="Exported cURL" readOnly value={curlExport} /><div className="modal-actions"><button className="save" onClick={() => setCurlExport(null)}>Close</button><button className="send" onClick={() => { void navigator.clipboard.writeText(curlExport).then(() => setNotice('cURL copied'), () => setNotice('Unable to access clipboard. Select and copy the command.')) }}>Copy command</button></div></Modal>}
    {showImport && <Modal title="Import from Postman" onClose={closeImport} wide>
      <p>Select a Postman collection JSON v2/v2.1, or paste its contents below. Import creates a new collection.</p>
      <label className="file-label">Choose JSON file<input type="file" aria-label="Postman collection file" accept=".json,application/json" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void loadPostmanFile(file) }} /></label>
      <textarea className="import-text" aria-label="Postman collection JSON" placeholder="Paste collection JSON here" value={importText} onChange={e => { importRead.current++; setImportLoading(false); setImportText(e.target.value); setImportPreview(null); setImportError('') }} />
      <button className="save" disabled={importLoading || !importText.trim()} onClick={() => previewImport(importText)}>{importLoading ? 'Reading file…' : 'Preview import'}</button>
      {importError && <p className="danger-text" role="alert">{importError}</p>}
      {importPreview && <div className="import-preview"><h3>{importPreview.collection.name}</h3><p>{importPreview.requests.length} requests · {importPreview.collection.variables?.length ?? 0} collection variables · {importPreview.skipped} skipped</p><ul className="import-requests">{importPreview.requests.slice(0, 15).map(r => <li key={r.id}><span className={r.method.toLowerCase()}>{r.method}</span> {r.name}</li>)}{importPreview.requests.length > 15 && <li>… and {importPreview.requests.length - 15} more</li>}</ul>{importPreview.warnings.length > 0 && <details open><summary>{importPreview.warnings.length} import warnings</summary><ul>{importPreview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}</div>}
      <div className="modal-actions"><button className="save" onClick={closeImport}>Cancel</button><button className="send" disabled={importLoading || !importPreview} onClick={confirmImport}>Import collection</button></div>
    </Modal>}
  </div>
}
export default App
