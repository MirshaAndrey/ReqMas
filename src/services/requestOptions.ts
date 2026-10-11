import type { AuthMode, AuthSettings, Collection, Request } from '../types/request'

export function authMode(auth: AuthSettings, fallback: AuthMode = 'inherit'): AuthMode {
  return auth.authMode ?? (auth.oauth ? 'oauth' : auth.basicAuth ? 'basic' : auth.bearerToken !== undefined ? 'bearer' : auth.apiKey ? 'apikey' : fallback)
}
export function changeAuthMode(mode: AuthMode): AuthSettings {
  return { authMode: mode, basicAuth: mode === 'basic' ? { username: '', password: '' } : undefined, bearerToken: mode === 'bearer' ? '' : undefined, oauth: mode === 'oauth' ? { tokenUrl: '', clientId: '', clientSecret: '', scope: '', accessToken: '', clientAuth: 'body', flow: 'client_credentials', autoRefresh: true } : undefined, apiKey: mode === 'apikey' ? { key: 'X-API-Key', value: '', in: 'header' } : undefined }
}
export function withCollectionAuth(request: Request, collection?: Collection): Request {
  const source: AuthSettings = authMode(request) === 'inherit' ? collection ?? {} : request
  const mode = authMode(source, 'none')
  return { ...request, authMode: mode, basicAuth: mode === 'basic' ? source.basicAuth : undefined, bearerToken: mode === 'bearer' ? source.bearerToken : undefined, oauth: mode === 'oauth' ? source.oauth : undefined, apiKey: mode === 'apikey' ? source.apiKey : undefined }
}
export function requestTimeout(request: Request): number {
  return Math.round(Math.min(300000, Math.max(100, Number.isFinite(request.timeoutMs) ? request.timeoutMs! : 30000)))
}
export function tokenExpiry(seconds: number): number | undefined { return Number.isFinite(seconds) && seconds >= 0 ? Math.min(8640000000000000, Date.now() + seconds * 1000) : undefined }
