import { useEffect, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { flushStorage, listWorkspaceBackups, read, readWorkspaceBackup, write } from '../storage/database'
import type { WorkspaceBackup } from '../services/backup'
import { backupFromStored } from '../services/storedBackup'
import { validateUpdateSettings } from '../services/updateSettings'
import type { UpdateInfo, UpdateSettings } from '../services/updateSettings'
import type { Request, WorkspaceData } from '../types/request'
import { APP_VERSION } from '../version'
import { Modal } from './Modal'
import './desktopSettings.css'

type Props = { data: WorkspaceData; drafts: Request[]; onRestore: (backup: WorkspaceBackup) => void | Promise<void>; onClose: () => void }
export function DesktopSettings({ onRestore, onClose }: Props) {
  const desktop = isTauri()
  const [settings, setSettings] = useState<UpdateSettings>(() => read('updates', { endpoint: '', publicKey: '' }))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [backups, setBackups] = useState<{ id: number; createdAt: number; size: number }[]>([])
  const [preview, setPreview] = useState<WorkspaceBackup | null>(null)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [confirmInstall, setConfirmInstall] = useState(false)
  useEffect(() => {
    if (!desktop) return
    let alive = true
    void listWorkspaceBackups().then(value => { if (alive) setBackups(value) }, err => { if (alive) setError(String(err)) })
    return () => { alive = false }
  }, [desktop])
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setNotice(''); try { await action() } catch (err) { setError(err instanceof Error ? err.message : String(err)); setConfirmInstall(false); setUpdate(null) } finally { setBusy(false) } }
  return <Modal title="App settings" onClose={() => { if (!busy) onClose() }} wide>
    <div className="desktop-settings"><h3>Local storage</h3>
      {desktop ? <><p>Workspace, drafts and preferences are saved in SQLite. Secret variables, stored credentials and private keys are protected for this user account using Windows DPAPI or an encryption key in macOS Keychain / Linux Secret Service. Use a workspace export with Include secrets to move credentials to another PC.</p><p>Automatic backups keep up to 10 snapshots, at most once a minute during ordinary edits. Restoring creates a snapshot first.</p>
        <button className="save" disabled={busy} onClick={() => void run(async () => { await flushStorage(); setBackups(await listWorkspaceBackups()); setNotice('Backup list refreshed.') })}>Refresh backups</button>
        {backups.length ? <div className="automatic-backups">{backups.map(backup => <div key={backup.id}><span>{new Date(backup.createdAt).toLocaleString()} <small>{(backup.size / 1024).toFixed(1)} KiB</small></span><button className="save" disabled={busy} aria-label={`Preview automatic backup ${backup.id}`} onClick={() => void run(async () => { setPreview(backupFromStored(await readWorkspaceBackup(backup.id))) })}>Preview backup</button></div>)}</div> : <p className="config-hint">No automatic backups yet. They appear as you save changes.</p>}
        {preview && <div className="backup-preview"><p>Restore {preview.data.collections.length} collections, {preview.data.requests.length} requests, {preview.data.environments.length} environments and {preview.drafts.length} drafts? This replaces your current workspace. The current workspace is backed up first.</p><div className="tool-row"><button className="save" disabled={busy} onClick={() => setPreview(null)}>Keep current workspace</button><button className="send" disabled={busy} onClick={() => void run(async () => { await onRestore(preview); onClose() })}>Restore automatic backup</button></div></div>}
      </> : <p>Browser mode saves this browser's workspace locally. SQLite, system-backed secret protection and automatic snapshots are available in the desktop app. You can export a backup using Workspace → Backup.</p>}
      <h3>Updates <span className="muted">Current version {APP_VERSION}</span></h3>
      <p>Set the HTTPS manifest address and trusted signing public key when your update server is ready. Leaving both empty disables update checks.</p>
      <div className="field-grid"><label>Update manifest URL<input disabled={!desktop || busy} aria-label="Update manifest URL" placeholder="https://updates.example.com/latest.json" value={settings.endpoint} onChange={e => { setSettings({ ...settings, endpoint: e.target.value }); setUpdate(null); setConfirmInstall(false) }} /></label><label>Trusted updater public key<textarea disabled={!desktop || busy} aria-label="Trusted updater public key" placeholder="Public key from tauri signer generate" value={settings.publicKey} onChange={e => { setSettings({ ...settings, publicKey: e.target.value }); setUpdate(null); setConfirmInstall(false) }} /></label></div>
      <div className="tool-row"><button className="save" disabled={!desktop || busy} onClick={() => void run(async () => { const next = validateUpdateSettings(settings); write('updates', next); await flushStorage(); setSettings(next); setNotice(next.endpoint ? 'Update settings saved.' : 'Update checks disabled.') })}>Save update settings</button><button className="save" disabled={!desktop || busy || !settings.endpoint.trim() || !settings.publicKey.trim()} onClick={() => void run(async () => { const config = validateUpdateSettings(settings, false); setUpdate(null); setConfirmInstall(false); const found = await invoke<UpdateInfo | null>('check_for_update', config); setUpdate(found); if (!found) setNotice('You are using the latest available version.') })}>Check for updates</button></div>
      {!desktop && <p className="config-hint">Install the desktop app to configure and install signed updates.</p>}
      {update && <div className="update-preview"><h4>Version {update.version} is available</h4>{update.date && <small>{update.date}</small>}<pre>{update.notes || 'No release notes provided.'}</pre>{confirmInstall ? <><p>Reqmas will close and start the signed installer. Your workspace will be saved first.</p><button className="save" disabled={busy} onClick={() => setConfirmInstall(false)}>Cancel installation</button><button className="send" disabled={busy} onClick={() => void run(async () => { await flushStorage(); await invoke('install_update', { checkId: update.checkId }); setNotice('Update installed. Restart Reqmas if it remains open.'); setUpdate(null) })}>Install version {update.version}</button></> : <button className="send" disabled={busy} onClick={() => setConfirmInstall(true)}>Review installation</button>}</div>}
      {busy && <p role="status">Working…</p>}{error && <p className="danger-text" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      <h3>Keyboard shortcuts</h3><p><kbd>Ctrl + Enter</kbd> Send request · <kbd>Ctrl + S</kbd> Save request · <kbd>Ctrl + K</kbd> Search collections. Shortcuts pause while a dialog is open.</p>
    </div><div className="modal-actions"><button className="save" disabled={busy} onClick={onClose}>Close settings</button></div>
  </Modal>
}
