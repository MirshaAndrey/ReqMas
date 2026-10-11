import type { Cookie, Pair, PreparedRequestSnapshot, Request, Response } from '../types/request'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { prepareRequest, RequestValidationError, resolveVariables } from './prepareRequest.ts'
import { cookiesFor } from './workspace.ts'
import { requestTimeout } from './requestOptions.ts'
import { bytesBase64, decodeResponseText, isBinaryResponse } from './responseEncoding.ts'
import { requestSnapshot } from './requestJournal.ts'
import { readResponseBytes } from './responseLimit.ts'
export { RequestValidationError } from './prepareRequest.ts'
export async function sendRequest(request: Request, signal: AbortSignal, collectionVariables: Pair[] = [], environmentVariables: Pair[] = [], cookies: Cookie[] = [], onPrepared?: (request: PreparedRequestSnapshot) => void): Promise<Response> {
  const prepared = prepareRequest(request, collectionVariables, environmentVariables)
  const variables = [...collectionVariables, ...environmentVariables, ...(request.variables ?? [])]
  const connection = request.connection && Object.fromEntries(Object.entries(request.connection).filter(([, value]) => value?.trim()).map(([key, value]) => [key, resolveVariables(value!, variables)]))
  const start = performance.now()
  if (isTauri()) {
    const cookie = cookiesFor(prepared.url, cookies)
    if (cookie && !Object.hasOwn(prepared.headers, 'cookie')) prepared.headers.cookie = cookie
    onPrepared?.(requestSnapshot(prepared))
    const requestId = crypto.randomUUID()
    const cancel = () => { void invoke('cancel_request', { requestId }).catch(() => {}) }
    signal.throwIfAborted()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const response = await invoke<Response>('send_request', { requestId, request: { ...prepared, body: prepared.body ?? null, timeoutMs: requestTimeout(request), followRedirects: request.followRedirects !== false, connection } })
      signal.throwIfAborted()
      if (!response.binary && response.bodyBase64 !== undefined) {
        const raw = Uint8Array.from(atob(response.bodyBase64), c => c.charCodeAt(0))
        const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? ''
        return { ...response, body: decodeResponseText(raw, contentType) }
      }
      return response
    } finally { signal.removeEventListener('abort', cancel) }
  }
  onPrepared?.(requestSnapshot(prepared))
  if (connection && Object.keys(connection).length) throw new RequestValidationError('Proxy and custom TLS certificates require Desktop mode. Clear the connection settings to send this request in the browser.')
  if (request.followRedirects === false) throw new RequestValidationError('Inspecting redirects without following them requires Desktop mode. Enable Follow redirects for browser requests.')
  const bytes = prepared.bodyBase64 === undefined ? undefined : Uint8Array.from(atob(prepared.bodyBase64), c => c.charCodeAt(0))
  const response = await fetch(prepared.url, { method: prepared.method, headers: prepared.headers, body: bytes ?? prepared.body, credentials: request.browserCookies ? 'include' : 'same-origin', signal })
  const receivedHeaders = performance.now()
  const received = await readResponseBytes(response, signal)
  signal.throwIfAborted()
  const binary = isBinaryResponse(received, response.headers.get('content-type') ?? '')
  return { status: response.status, statusText: response.statusText, duration: Math.round(performance.now() - start), headersDuration: Math.round(receivedHeaders - start), downloadDuration: Math.round(performance.now() - receivedHeaders), size: received.length, headers: Object.fromEntries(response.headers.entries()), body: binary ? '' : decodeResponseText(received, response.headers.get('content-type') ?? ''), bodyBase64: bytesBase64(received), binary, url: response.url }
}
