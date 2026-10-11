import type { PreparedRequestSnapshot, RequestJournalEntry, Response } from '../types/request'

export function requestSnapshot(prepared: { method: string; url: string; headers: Record<string, string>; body?: string; bodyBase64?: string }): PreparedRequestSnapshot {
  const bytes = new TextEncoder().encode(prepared.body ?? '')
  const limit = 100 * 1024
  return { method: prepared.method, url: prepared.url, headers: { ...prepared.headers }, body: prepared.body === undefined ? undefined : new TextDecoder().decode(bytes.subarray(0, limit), { stream: bytes.length > limit }), binarySize: prepared.bodyBase64 === undefined ? undefined : Math.floor(prepared.bodyBase64.length * 3 / 4) - (prepared.bodyBase64.endsWith('==') ? 2 : prepared.bodyBase64.endsWith('=') ? 1 : 0), bodyTruncated: bytes.length > limit }
}

export function completeJournal(entry: RequestJournalEntry, response: Response): RequestJournalEntry {
  return { ...entry, state: 'complete', duration: response.duration, status: response.status, statusText: response.statusText, finalUrl: response.url, headersDuration: response.headersDuration, downloadDuration: response.downloadDuration, responseHeaders: { ...response.headers }, redirects: response.redirects?.map(redirect => ({ ...redirect })) }
}

export function displayHeaders(headers: Record<string, string>, reveal = false): string {
  return Object.entries(headers).map(([key, value]) => `${key}: ${!reveal && /authorization|cookie|token|secret|api[-_]?key|(?:^|[-_])key(?:$|[-_])/i.test(key) ? '••••••' : value}`).join('\n') || '(no explicit headers)'
}
