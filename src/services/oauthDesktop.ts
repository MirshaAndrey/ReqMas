import { invoke, isTauri } from '@tauri-apps/api/core'
import type { OAuth } from '../types/request'
import { authorizationUrl, createPkce, DEFAULT_REDIRECT_URI } from './oauth.ts'

export async function authorizeOAuth(oauth: OAuth, signal: AbortSignal): Promise<{ code: string; verifier: string }> {
  if (!isTauri()) throw new Error('Authorization Code + PKCE uses the system browser and requires Desktop mode. You can paste a token here or use Client Credentials.')
  const pkce = await createPkce(), sessionId = crypto.randomUUID()
  const url = authorizationUrl(oauth, pkce)
  const cancel = () => { void invoke('cancel_oauth', { sessionId }).catch(() => {}) }
  signal.throwIfAborted()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const code = await invoke<string>('oauth_authorize', { authorizationUrl: url, redirectUri: oauth.redirectUri || DEFAULT_REDIRECT_URI, state: pkce.state, sessionId })
    signal.throwIfAborted()
    return { code, verifier: pkce.verifier }
  } finally { signal.removeEventListener('abort', cancel) }
}
