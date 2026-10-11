import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import './terminal.css'
import { applyTheme, getTheme } from './theme'
import { initializeStorage } from './storage/database'
import { desktopStorage, flushStorage } from './storage/database'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { installStorageCloseGuard } from './storage/closeGuard'

const root = createRoot(document.getElementById('root')!)
let starting = false
let closeGuardInstalled = false, stopCloseGuard: (() => void) | undefined
async function installCloseGuard() {
  if (!desktopStorage() || closeGuardInstalled) return
  const appWindow = getCurrentWindow()
  stopCloseGuard = await installStorageCloseGuard(appWindow, () => flushStorage(true), error => window.dispatchEvent(new CustomEvent('reqmas-storage-error', { detail: `Workspace could not be saved. The window remains open. ${error instanceof Error ? error.message : String(error)}. Download a backup before closing.` })), blocked => { document.body.inert = blocked })
  closeGuardInstalled = true
}
async function startApplication() {
  if (starting) return
  starting = true
  root.render(<div role="status" style={{ padding: '40px', maxWidth: '600px', margin: 'auto' }}>Loading your workspace…</div>)
  try {
    await initializeStorage()
    await installCloseGuard()
    applyTheme(getTheme())
    root.render(<StrictMode><App /></StrictMode>)
  } catch (error) {
    root.render(<div role="alert" style={{ padding: '40px', maxWidth: '600px', margin: 'auto', lineHeight: 1.7 }}><h1>Could not open your workspace</h1><p>{error instanceof Error ? error.message : String(error)}</p><p>Your saved workspace is preserved. Resolve the storage problem, then retry.</p><button className="save" onClick={() => { void startApplication() }}>Retry opening workspace</button></div>)
  } finally { starting = false }
}
void startApplication()
import.meta.hot?.dispose(() => { stopCloseGuard?.() })
