/** A failed commit keeps the window open; a repeated close never starts duplicate saves. */
export function createStorageCloseGuard(flush: () => Promise<void>, close: () => Promise<void>, onError: (error: unknown) => void, blockEditing: (blocked: boolean) => void) {
  let permitted = false, closing = false
  return async (event: { preventDefault: () => void }) => {
    if (permitted) return
    event.preventDefault()
    if (closing) return
    closing = true; blockEditing(true)
    try { await flush(); permitted = true; await close() }
    catch (error) { permitted = false; onError(error) }
    finally { closing = false; blockEditing(false) }
  }
}

type CloseEvent = { preventDefault: () => void }
type DesktopWindow = {
  onCloseRequested: (handler: (event: CloseEvent) => Promise<void>) => Promise<() => void>
  destroy: () => Promise<void>
}

/** Destroy after saving rather than generating a second native close request. */
export function installStorageCloseGuard(appWindow: DesktopWindow, flush: () => Promise<void>, onError: (error: unknown) => void, blockEditing: (blocked: boolean) => void) {
  return appWindow.onCloseRequested(createStorageCloseGuard(flush, () => appWindow.destroy(), onError, blockEditing))
}
