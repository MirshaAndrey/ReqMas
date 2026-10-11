import { useEffect, useRef, useState } from 'react'
import type { WorkspaceData, Request } from '../types/request'
import type { WorkspaceBackup as Backup } from '../services/backup'
import { createExportBackup, MAX_BACKUP_BYTES, parseBackup } from '../services/backup'
import { downloadJson } from '../services/workspace'
import { getTheme } from '../theme'

type Props = { data: WorkspaceData; drafts: Request[]; onRestore: (backup: Backup) => void | Promise<void>; onBusy?: (busy: boolean) => void }
export function WorkspaceBackup({ data, drafts, onRestore, onBusy }: Props) {
  const [text, setText] = useState(''); const [preview, setPreview] = useState<Backup | null>(null); const [error, setError] = useState('')
  const [exportText, setExportText] = useState(''), [includeSecrets, setIncludeSecrets] = useState(false)
  const [reading, setReading] = useState(false), [restoring, setRestoring] = useState(false)
  const fileRead = useRef(0), committing = useRef(false), alive = useRef(true)
  useEffect(() => () => { fileRead.current++ }, [])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const inspect = (value: string) => { setText(value); setPreview(null); setError(''); try { setPreview(parseBackup(value)) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } }
  const loadFile = async (file: File) => {
    const token = ++fileRead.current
    setReading(true); setText(''); setPreview(null); setError('')
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('Workspace backup exceeds 50 MB')
      const value = await file.text()
      if (fileRead.current === token) inspect(value)
    } catch (error) { if (fileRead.current === token) setError(error instanceof Error ? error.message : String(error)) }
    finally { if (fileRead.current === token) setReading(false) }
  }
  const restore = async () => {
    if (!preview || committing.current || reading) return
    committing.current = true; setRestoring(true); setError(''); onBusy?.(true)
    try { await onRestore(structuredClone(preview)); if (alive.current) setPreview(null) }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)) }
    finally { committing.current = false; if (alive.current) { setRestoring(false); onBusy?.(false) } }
  }
  const backup = () => createExportBackup(data, getTheme(), drafts, { includeSecrets })
  return <div className="backup-tools"><p>Back up collections, requests, open drafts, environments, cookies, history, Runner scenarios and theme.</p>
    <label className="check-label"><input disabled={restoring} type="checkbox" aria-label="Include secrets in workspace backup" checked={includeSecrets} onChange={event => { setIncludeSecrets(event.target.checked); setExportText('') }} /> Include secrets</label>
    <p className={includeSecrets ? 'danger-text' : 'config-hint'}>{includeSecrets ? 'This file will contain passwords, tokens, marked secret values, cookie values and private keys. Store it securely.' : 'Marked secret values, authentication credentials, cookie values and private keys are excluded. Manually embedded secrets in URLs, request or response bodies, datasets and attachments may still be present.'}</p>
    <div className="tool-row"><button className="save" disabled={restoring} onClick={() => { try { downloadJson('reqmas-workspace', backup()); setError('') } catch (error) { setError(error instanceof Error ? error.message : String(error)) } }}>Download workspace backup</button><button className="save" disabled={restoring} onClick={() => { try { setExportText(exportText ? '' : JSON.stringify(backup(), null, 2)); setError('') } catch (error) { setError(error instanceof Error ? error.message : String(error)) } }}>{exportText ? 'Hide backup JSON' : 'Show backup JSON'}</button></div>{exportText && <textarea className="import-text" aria-label="Exported workspace backup" readOnly value={exportText} />}
    <h3>Restore workspace</h3><label className="file-label">Choose backup JSON<input disabled={restoring || reading} type="file" accept=".json,application/json" aria-label="Workspace backup file" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void loadFile(file) }} /></label>
    <textarea disabled={restoring} className="import-text" aria-label="Workspace backup JSON" placeholder="Or paste a workspace backup" value={text} onChange={e => { fileRead.current++; setReading(false); setText(e.target.value); setPreview(null); setError('') }} />{reading && <p role="status">Reading workspace backup…</p>}<button className="save" disabled={restoring || reading || !text.trim()} onClick={() => inspect(text)}>Preview backup</button>
    {error && <p role="alert" className="danger-text">{error}</p>}{preview && <div className="import-preview"><p>{preview.data.collections.length} collections · {preview.data.requests.length} requests · {preview.data.environments.length} environments · {preview.data.history.length} history entries · {preview.data.runnerScenarios?.length ?? 0} Runner scenarios</p><p>Created {new Date(preview.exportedAt).toLocaleString()}. Restoring replaces the current workspace. Download its backup first if you want to keep it.</p><button className="send" disabled={restoring || reading} onClick={() => void restore()}>{restoring ? 'Restoring workspace…' : 'Restore this workspace'}</button></div>}
    {restoring && <p role="status">Saving restored workspace…</p>}
  </div>
}
