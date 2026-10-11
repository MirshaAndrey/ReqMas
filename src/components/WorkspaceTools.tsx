import { useEffect, useRef, useState } from 'react'
import type { Collection, Cookie, Environment, Request, WorkspaceData } from '../types/request'
import type { WorkspaceBackup as Backup } from '../services/backup'
import { WorkspaceBackup } from './WorkspaceBackup'
import { downloadJson, exportCollection, exportEnvironment, importEnvironment, validCookie } from '../services/workspace'
import { Modal } from './Modal'
import { PairEditor } from './PairEditor'

type Props = { data: WorkspaceData; drafts: Request[]; onRestore: (backup: Backup) => void | Promise<void>; environments: Environment[]; collections: Collection[]; requests: Request[]; cookies: Cookie[]; desktop: boolean; onEnvironments: (v: Environment[]) => void; onCookies: (v: Cookie[]) => void; onClose: () => void }
export function WorkspaceTools(p: Props) {
  const [section, setSection] = useState('Environments')
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [environments, setEnvironments] = useState(() => structuredClone(p.environments))
  const [selected, setSelected] = useState(environments[0]?.id ?? '')
  const [cookies, setCookies] = useState(() => structuredClone(p.cookies))
  const [json, setJson] = useState(''); const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [reading, setReading] = useState(false)
  const fileRead = useRef(0)
  useEffect(() => () => { fileRead.current++ }, [])
  const loadEnvironment = async (file: File) => {
    const token = ++fileRead.current
    setReading(true); setError(''); setJson('')
    try {
      if (file.size > 1024 * 1024) throw new Error('Environment file exceeds 1 MiB.')
      const text = await file.text()
      if (fileRead.current === token) setJson(text)
    } catch (error) { if (fileRead.current === token) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (fileRead.current === token) setReading(false) }
  }
  const env = environments.find(e => e.id === selected)
  const update = (change: Partial<Environment>) => setEnvironments(es => es.map(e => e.id === selected ? { ...e, ...change } : e))
  const exportJson = (name: string, create: () => unknown) => {
    try { downloadJson(name, create()); setError('') }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }
  return <Modal title="Workspace tools" onClose={() => { if (!restoring) p.onClose() }} wide>
    <div className="tool-tabs">{['Environments', 'Export', 'Cookies', 'Backup'].map(s => <button disabled={restoring} className={section === s ? 'active' : ''} key={s} onClick={() => { setSection(s); setError('') }}>{s}</button>)}</div>
    {section === 'Backup' && <WorkspaceBackup data={{ ...p.data, environments, cookies, environmentId: environments.some(e => e.id === p.data.environmentId) ? p.data.environmentId : '' }} drafts={p.drafts} onRestore={p.onRestore} onBusy={setRestoring} />}
    {(section === 'Environments' || section === 'Export') && <><label className="check-label"><input type="checkbox" aria-label="Include secrets in JSON export" checked={includeSecrets} onChange={e => setIncludeSecrets(e.target.checked)} /> Include secrets in JSON export</label><p className="config-hint">{includeSecrets ? 'Exports will contain credentials in plain text. Store and share them carefully.' : 'Secret variables and structured credentials are blanked. URLs, bodies and attachments may contain values you entered manually.'}</p></>}
    {section === 'Environments' && <>
      <div className="tool-row"><select aria-label="Edit environment" value={selected} onChange={e => { setSelected(e.target.value); setDeleting(false) }}><option value="">Choose an environment</option>{environments.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select><button className="save" onClick={() => { const e = { id: crypto.randomUUID(), name: 'New environment', variables: [] }; setEnvironments([...environments, e]); setSelected(e.id); setDeleting(false) }}>+ New</button></div>
      {env ? <><label>Environment name<input aria-label="Environment name" value={env.name} onChange={e => update({ name: e.target.value })} /></label><PairEditor allowSecrets label="environment variable" rows={env.variables} onChange={variables => update({ variables })} /><p>Priority: collection → environment → request. Use {'{{baseUrl}}'}, {'{{token}}'} and other variables in requests.</p><div className="tool-row"><button className="save" onClick={() => { const copy = { ...structuredClone(env), id: crypto.randomUUID(), name: env.name + ' (copy)' }; setEnvironments([...environments, copy]); setSelected(copy.id); setDeleting(false) }}>Duplicate</button><button className="save" onClick={() => exportJson(env.name + '.postman_environment', () => exportEnvironment(env, { includeSecrets }))}>Export JSON</button><button className="save danger-text" onClick={() => setDeleting(true)}>Delete environment</button></div>{deleting && <div className="inline-confirm">Delete “{env.name}”?<button className="save" onClick={() => setDeleting(false)}>Keep</button><button className="danger-button" onClick={() => { setEnvironments(environments.filter(e => e.id !== selected)); setSelected(''); setDeleting(false) }}>Confirm delete</button></div>}</> : <p>Create Development, Staging or Production and add baseUrl and token variables.</p>}
      <details className="tool-import"><summary>Import Postman environment</summary><input type="file" aria-label="Environment JSON file" accept=".json" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void loadEnvironment(f) }} /><textarea aria-label="Environment JSON" className="import-text" value={json} onChange={e => { fileRead.current++; setReading(false); setJson(e.target.value); setError('') }} placeholder="Paste exported environment JSON" />{reading && <p role="status">Reading environment file…</p>}<button className="save" disabled={reading || !json.trim()} onClick={() => { try { const e = importEnvironment(json); setEnvironments([...environments, e]); setSelected(e.id); setDeleting(false); setJson(''); setError('') } catch (e) { setError(String(e)) } }}>Import environment</button></details>
    </>}
    {section === 'Export' && <><p>Download collections as Postman v2.1 JSON. Files are embedded for Reqmas; reattach them in Postman. Reqmas assertions are preserved as extra metadata.</p>{p.collections.map(c => <div className="export-row" key={c.id}><span>{c.name}</span><button className="save" onClick={() => exportJson(c.name + '.postman_collection', () => exportCollection(c, p.requests, { includeSecrets }))}>Export collection</button></div>)}<p>Exports contain saved requests and attached files; Include secrets controls credential values.</p></>}
    {section === 'Cookies' && <><p>{p.desktop ? 'Desktop cookie jar: cookies received from servers are saved for the exact responding host, with path, expiry and HTTPS rules. Subdomain sharing can be enabled per cookie.' : 'In browser mode the browser manages cookies. The jar below is used only in the desktop app; browser APIs hide Set-Cookie. Enable browser cookies in the request Auth tab when needed.'}</p><button className="save" onClick={() => setCookies([...cookies, { id: crypto.randomUUID(), name: '', value: '', domain: '', path: '/', secure: true, hostOnly: true }])}>+ Add cookie</button>{cookies.map(c => <div className="cookie-card" key={c.id}><div className="field-grid">{(['name', 'value', 'domain', 'path'] as const).map(k => <label key={k}>{k}<input aria-label={`Cookie ${k}`} value={c[k]} onChange={e => setCookies(cs => cs.map(old => old.id === c.id ? { ...old, [k]: k === 'domain' ? e.target.value.toLowerCase().replace(/^\./, '') : e.target.value } : old))} /></label>)}</div><label><input type="checkbox" checked={c.secure} onChange={e => setCookies(cs => cs.map(old => old.id === c.id ? { ...old, secure: e.target.checked } : old))} /> HTTPS only</label><label><input type="checkbox" checked={c.hostOnly} onChange={e => setCookies(cs => cs.map(old => old.id === c.id ? { ...old, hostOnly: e.target.checked } : old))} /> Exact host only</label><small>{c.expiresAt !== undefined ? `Expires ${new Date(c.expiresAt).toLocaleString()}` : 'Session cookie'}</small><button className="save danger-text" onClick={() => setCookies(cookies.filter(old => old.id !== c.id))}>Remove cookie</button></div>)}</>}
    {error && <p role="alert" className="danger-text">{error}</p>}
    <div className="modal-actions"><button className="save" disabled={restoring} onClick={p.onClose}>Cancel</button><button className="send" disabled={restoring} onClick={() => {
      if (environments.some(e => !e.name.trim())) { setError('Enter a name for each environment.'); return }
      if (cookies.some(c => !validCookie(c))) { setError('Cookies need a valid name, value, domain and path.'); return }
      p.onEnvironments(environments); p.onCookies(cookies); p.onClose()
    }}>Save workspace</button></div>
  </Modal>
}
