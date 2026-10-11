import type { WorkspaceData, Request, Collection, Response } from '../types/request'
import { validCookie } from './workspace.ts'
import type { Cookie } from '../types/request'
import { validateRunnerScenarios } from './runnerScenarios.ts'
import { redactRequest, redactWorkspace } from './secretExport.ts'
import type { ExportOptions } from './secretExport.ts'
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024
export const MAX_BACKUP_ITEMS = 10000
export type WorkspaceBackup = { format: 'reqmas.workspace'; version: 1; exportedAt: string; theme: 'light' | 'dark' | 'system'; data: WorkspaceData; drafts: Request[] }
type Obj = Record<string, unknown>
const fail = (path: string): never => { throw new Error(`Invalid workspace backup: ${path}`) }
const obj = (value: unknown, path: string): Obj => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : fail(path)
const str = (value: unknown, path: string) => typeof value === 'string' ? value : fail(path)
const num = (value: unknown, path: string) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fail(path)
const bool = (value: unknown, path: string) => typeof value === 'boolean' ? value : fail(path)
const list = (value: unknown, path: string): unknown[] => !Array.isArray(value) ? fail(path) : value.length <= MAX_BACKUP_ITEMS ? value : fail(`${path} (maximum ${MAX_BACKUP_ITEMS.toLocaleString('en-US')} entries)`)
const choice = (value: unknown, choices: string[], path: string) => choices.includes(str(value, path)) ? value : fail(path)
function uniqueIds(entries: unknown[], path: string) { const ids = new Set<string>(); entries.forEach(entry => { const id = str(obj(entry, path).id, path + '.id'); if (!id || ids.has(id)) fail(path + '.duplicate or empty ID'); ids.add(id) }) }
function pairs(value: unknown, path: string) { const entries = list(value, path); entries.forEach((entry, i) => { const p = obj(entry, `${path}.${i}`); ['id', 'key', 'value'].forEach(key => str(p[key], `${path}.${key}`)); bool(p.enabled, path + '.enabled'); if (p.secret !== undefined) bool(p.secret, path + '.secret') }); uniqueIds(entries, path) }
function file(value: unknown, path: string) { const f = obj(value, path); str(f.name, path + '.name'); str(f.type, path + '.type'); const bytes = str(f.base64, path + '.base64'); if (bytes.length > 14 * 1024 * 1024 || bytes.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(bytes)) fail(path + '.base64') }
function auth(value: Obj, path: string) {
  if (value.authMode !== undefined) choice(value.authMode, ['inherit', 'none', 'basic', 'bearer', 'oauth', 'apikey'], path + '.authMode')
  if (value.bearerToken !== undefined) str(value.bearerToken, path + '.bearerToken')
  if (value.basicAuth !== undefined) { const a = obj(value.basicAuth, path + '.basicAuth'); str(a.username, path + '.username'); str(a.password, path + '.password') }
  if (value.apiKey !== undefined) { const a = obj(value.apiKey, path + '.apiKey'); str(a.key, path + '.key'); str(a.value, path + '.value'); choice(a.in, ['header', 'query'], path + '.in') }
  if (value.oauth !== undefined) { const a = obj(value.oauth, path + '.oauth'); ['tokenUrl', 'clientId', 'clientSecret', 'scope', 'accessToken'].forEach(key => str(a[key], path + '.' + key)); if (a.expiresAt !== undefined) num(a.expiresAt, path + '.expiresAt'); if (a.clientAuth !== undefined) choice(a.clientAuth, ['basic', 'body'], path + '.clientAuth'); if (a.flow !== undefined) choice(a.flow, ['client_credentials', 'authorization_code'], path + '.oauth.flow'); for (const key of ['authorizationUrl', 'redirectUri', 'refreshToken']) if (a[key] !== undefined) str(a[key], path + '.oauth.' + key); if (a.autoRefresh !== undefined) bool(a.autoRefresh, path + '.oauth.autoRefresh') }
}
function request(value: unknown, path: string): Request {
  const r = obj(value, path)
  for (const key of ['id', 'collectionId', 'name', 'url', 'body']) str(r[key], path + '.' + key)
  if (!r.id) fail(path + '.id')
  choice(r.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], path + '.method')
  choice(r.bodyType, ['none', 'json', 'text', 'xml', 'urlencoded', 'formdata', 'binary'], path + '.bodyType')
  pairs(r.params, path + '.params'); pairs(r.headers, path + '.headers')
  for (const key of ['variables', 'form']) if (r[key] !== undefined) pairs(r[key], path + '.' + key)
  if (r.folder !== undefined) str(r.folder, path + '.folder')
  if (r.responseSchema !== undefined) str(r.responseSchema, path + '.responseSchema')
  if (r.timeoutMs !== undefined) { const timeout = num(r.timeoutMs, path + '.timeoutMs'); if (timeout < 100 || timeout > 300000) fail(path + '.timeoutMs') }
  for (const key of ['followRedirects', 'browserCookies']) if (r[key] !== undefined) bool(r[key], path + '.' + key)
  if (r.connection !== undefined) { const connection = obj(r.connection, path + '.connection'); for (const key of ['proxyUrl', 'proxyUsername', 'proxyPassword', 'caPem', 'clientCertPem', 'clientKeyPem']) if (connection[key] !== undefined) { const value = str(connection[key], path + '.connection.' + key); if (value.length > 1024 * 1024) fail(path + '.connection.' + key + ' exceeds 1 MiB') } }
  if (r.binary !== undefined) file(r.binary, path + '.binary')
  if (r.files !== undefined) { const entries = list(r.files, path + '.files'); entries.forEach(entry => { file(entry, path + '.file'); const f = obj(entry, path); str(f.id, path + '.file.id'); str(f.key, path + '.file.key'); bool(f.enabled, path + '.file.enabled') }); uniqueIds(entries, path + '.files') }
  if (r.tests !== undefined) { const entries = list(r.tests, path + '.tests'); entries.forEach(entry => { const t = obj(entry, path); ['id', 'key', 'expected'].forEach(key => str(t[key], path + '.test.' + key)); choice(t.kind, ['status', 'duration', 'contains', 'header', 'json'], path + '.test.kind'); bool(t.enabled, path + '.test.enabled') }); uniqueIds(entries, path + '.tests') }
  if (r.extractions !== undefined) { const entries = list(r.extractions, path + '.extractions'); entries.forEach(entry => { const t = obj(entry, path); ['id', 'path', 'variable'].forEach(key => str(t[key], path + '.capture.' + key)); choice(t.source, ['json', 'header'], path + '.capture.source'); bool(t.enabled, path + '.capture.enabled') }); uniqueIds(entries, path + '.extractions') }
  auth(r, path)
  return r as Request
}
function collection(value: unknown, path: string): Collection {
  const c = obj(value, path); if (!str(c.id, path + '.id')) fail(path + '.id'); str(c.name, path + '.name')
  if (c.variables !== undefined) pairs(c.variables, path + '.variables')
  if (c.folders !== undefined) list(c.folders, path + '.folders').forEach(value => str(value, path + '.folder'))
  auth(c, path); return c as Collection
}
function response(value: unknown, path: string): Response {
  const r = obj(value, path); ['status', 'duration', 'size'].forEach(key => num(r[key], path + '.' + key)); str(r.body, path + '.body'); str(r.statusText, path + '.statusText')
  Object.values(obj(r.headers, path + '.headers')).forEach(v => str(v, path + '.header'))
  if (r.url !== undefined) str(r.url, path + '.url')
  if (r.bodyBase64 !== undefined) { const bytes = str(r.bodyBase64, path + '.bodyBase64'); if (bytes.length > 14 * 1024 * 1024 || bytes.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(bytes)) fail(path + '.bodyBase64') }
  for (const key of ['binary', 'bodyTruncated']) if (r[key] !== undefined) bool(r[key], path + '.' + key)
  for (const key of ['headersDuration', 'downloadDuration']) if (r[key] !== undefined) num(r[key], path + '.' + key)
  if (r.redirects !== undefined) list(r.redirects, path + '.redirects').forEach(value => { const d = obj(value, path); str(d.from, path); str(d.to, path); num(d.status, path) })
  if (r.setCookies !== undefined) list(r.setCookies, path).forEach(v => str(v, path + '.setCookie'))
  if (r.captures !== undefined) list(r.captures, path).forEach(v => { const c = obj(v, path); str(c.name, path); str(c.actual, path); bool(c.passed, path) })
  return r as Response
}
export function createBackup(data: WorkspaceData, theme: WorkspaceBackup['theme'], drafts: Request[] = []): WorkspaceBackup {
  return { format: 'reqmas.workspace', version: 1, exportedAt: new Date().toISOString(), theme, data: structuredClone(data), drafts: structuredClone(drafts) }
}
export function createExportBackup(data: WorkspaceData, theme: WorkspaceBackup['theme'], drafts: Request[] = [], options: ExportOptions = {}): WorkspaceBackup {
  const backup = createBackup(options.includeSecrets ? data : redactWorkspace(data), theme, options.includeSecrets ? drafts : drafts.map(redactRequest))
  // Both download and the JSON preview use this formatting. Validate those bytes,
  // so an export never advertises a backup that its own restore dialog refuses.
  parseBackup(JSON.stringify(backup, null, 2))
  return backup
}
export function validateBackupRequest(value: Request): void { request(value, 'request') }
export function validateBackupCollection(value: Collection): void { collection(value, 'collection') }
export function parseBackup(text: string): WorkspaceBackup {
  if (text.length > MAX_BACKUP_BYTES || new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error('Workspace backup exceeds 50 MB')
  let parsed: unknown; try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { throw new Error('The backup is not valid JSON') }
  const root = obj(parsed, 'root')
  if (root.format !== 'reqmas.workspace' || root.version !== 1) throw new Error('Choose a Reqmas workspace backup (version 1)')
  choice(root.theme, ['light', 'dark', 'system'], 'theme'); str(root.exportedAt, 'exportedAt')
  const data = obj(root.data, 'data')
  const collections = list(data.collections, 'collections').map((v, i) => collection(v, `collections.${i}`))
  const requests = list(data.requests, 'requests').map((v, i) => request(v, `requests.${i}`))
  for (const values of [collections, requests]) if (new Set(values.map(v => v.id)).size !== values.length) fail('duplicate collection or request IDs')
  if (requests.some(r => !collections.some(c => c.id === r.collectionId))) fail('request collection reference')
  const environments = list(data.environments, 'environments').map(v => { const e = obj(v, 'environment'); str(e.id, 'environment.id'); str(e.name, 'environment.name'); pairs(e.variables, 'environment.variables'); return e })
  uniqueIds(environments, 'environments')
  const environmentId = str(data.environmentId, 'environmentId'); if (environmentId && !environments.some(e => e.id === environmentId)) fail('active environment reference')
  const cookies = list(data.cookies, 'cookies'); cookies.forEach(v => { const c = obj(v, 'cookie'); ['id', 'name', 'value', 'domain', 'path'].forEach(k => str(c[k], 'cookie.' + k)); bool(c.secure, 'cookie.secure'); bool(c.hostOnly, 'cookie.hostOnly'); if (c.expiresAt !== undefined) num(c.expiresAt, 'cookie.expiresAt'); if (!validCookie(c as Cookie)) fail('cookie.name, value, domain or path') }); uniqueIds(cookies, 'cookies')
  const history = list(data.history, 'history'); history.forEach(v => { const h = obj(v, 'history'); str(h.id, 'history.id'); str(h.time, 'history.time'); num(h.status, 'history.status'); num(h.duration, 'history.duration'); request(h.request, 'history.request'); if (h.response !== undefined) response(h.response, 'history.response'); if (h.bodyTruncated !== undefined) bool(h.bodyTruncated, 'history.bodyTruncated') }); uniqueIds(history, 'history')
  const trash = obj(data.trash, 'trash'); const trashCollections = list(trash.collections, 'trash.collections'), trashRequests = list(trash.requests, 'trash.requests'); trashCollections.forEach(v => collection(v, 'trash.collection')); trashRequests.forEach(v => request(v, 'trash.request')); uniqueIds(trashCollections, 'trash.collections'); uniqueIds(trashRequests, 'trash.requests')
  if (data.runnerScenarios !== undefined) data.runnerScenarios = validateRunnerScenarios(data.runnerScenarios)
  const drafts = root.drafts === undefined ? [] : list(root.drafts, 'drafts').map(v => request(v, 'draft'))
  return { format: 'reqmas.workspace', version: 1, exportedAt: root.exportedAt as string, theme: root.theme as WorkspaceBackup['theme'], data: data as WorkspaceData, drafts }
}
