import { useEffect, useState } from 'react'
import type { SetStateAction } from 'react'
import type { AssertionResult, Request, Response } from '../types/request'
import { read, write } from '../storage/database'
import { normalizeRequestQuery } from '../services/queryParams'

export type RequestTab = { id: string; request: Request; response: Response | null; assertions: AssertionResult[]; error: string; busy: boolean; editor: string; view: string; search: string; match: number; historyNote: string }
const tabFor = (request: Request, response: Response | null = null): RequestTab => ({ id: crypto.randomUUID(), request: normalizeRequestQuery(structuredClone(request)), response, assertions: response?.captures ?? [], error: '', busy: false, editor: 'Params', view: 'Pretty', search: '', match: 0, historyNote: '' })
export function useRequestTabs(initial: Request, onStorageError: (message: string) => void) {
  const [tabs, setTabs] = useState<RequestTab[]>(() => {
    const stored = read<{ request: Request }[]>('tabs', [])
    return Array.isArray(stored) && stored.length && stored.every(t => t?.request?.id && Array.isArray(t.request.headers)) ? stored.map(t => tabFor(t.request)) : [tabFor(initial)]
  })
  const [activeId, setActiveId] = useState('')
  const active = tabs.find(tab => tab.id === activeId) ?? tabs[0]
  useEffect(() => { try { write('tabs', tabs.map(tab => ({ request: tab.request }))) } catch { queueMicrotask(() => onStorageError('Storage is full. Open drafts could not be saved.')) } }, [tabs, onStorageError])
  const field = <K extends keyof RequestTab>(key: K) => (value: SetStateAction<RequestTab[K]>) => setTabs(all => all.map(tab => tab.id === active.id ? { ...tab, [key]: typeof value === 'function' ? (value as (old: RequestTab[K]) => RequestTab[K])(tab[key]) : value } : tab))
  const open = (request: Request, response?: Response, historyNote = '') => {
    const existing = response || historyNote ? undefined : tabs.find(tab => tab.request.id === request.id && !tab.historyNote)
    if (existing) { setActiveId(existing.id); return }
    const next = tabFor(request, response); next.historyNote = historyNote
    setTabs(all => [...all, next]); setActiveId(next.id)
  }
  const close = (id: string, fallback: Request) => {
    const remaining = tabs.filter(tab => tab.id !== id)
    if (!remaining.length) remaining.push(tabFor(fallback))
    setTabs(remaining); if (active.id === id) setActiveId(remaining.at(-1)!.id)
  }
  const reset = (requests: Request[]) => { const next = (requests.length ? requests : [initial]).map(r => tabFor(r)); setTabs(next); setActiveId(next[0].id) }
  return { tabs, active, setActiveId, field, open, close, reset, setTabs }
}
