import type { Pair, Request } from '../types/request'

type QueryRequest = Pick<Request, 'url' | 'params'>

// Split templates and incomplete editor URLs without requiring a valid absolute URL.
export function splitQueryUrl(url: string) {
  const hash = url.indexOf('#')
  const fragment = hash < 0 ? '' : url.slice(hash)
  const address = hash < 0 ? url : url.slice(0, hash)
  const question = address.indexOf('?')
  return { base: question < 0 ? address : address.slice(0, question), fragment, query: question < 0 ? '' : address.slice(question + 1) }
}

export function queryRows(request: QueryRequest): Pair[] {
  const managed = new Set(request.params.filter(p => p.key).map(p => p.key))
  const usedIds = new Set(request.params.map(p => p.id))
  const inline = Array.from(new URLSearchParams(splitQueryUrl(request.url).query), ([key, value], index) => {
    let id = `url-query-${index}`
    while (usedIds.has(id)) id += '-'
    usedIds.add(id)
    return { id, key, value, enabled: true }
  }).filter(p => !managed.has(p.key))
  return [...inline, ...request.params]
}

function encodeTemplate(value: string): string {
  return value.split(/(\{\{[^{}]+\}\})/g).map(part => /^\{\{[^{}]+\}\}$/.test(part) ? part : new URLSearchParams({ v: part }).toString().slice(2)).join('')
}

export function changeRequestParams(request: QueryRequest, params: Pair[]): QueryRequest {
  const { base, fragment } = splitQueryUrl(request.url)
  const query = params.filter(p => p.enabled && p.key).map(p => `${encodeTemplate(p.key)}=${encodeTemplate(p.value)}`).join('&')
  return { url: base + (query ? '?' + query : '') + fragment, params }
}

export function changeRequestUrl(request: QueryRequest, url: string): QueryRequest {
  const available = [...queryRows(request)]
  const params = Array.from(new URLSearchParams(splitQueryUrl(url).query), ([key, value]) => {
    let index = available.findIndex(p => p.key === key && p.value === value)
    if (index < 0) index = available.findIndex(p => p.key === key)
    const old = index < 0 ? undefined : available.splice(index, 1)[0]
    return { id: old?.id ?? crypto.randomUUID(), key, value, enabled: true }
  })
  // Disabled rows are kept for later reuse, unless the URL explicitly enables them.
  return { url, params: [...params, ...available.filter(p => !p.enabled)] }
}

export function normalizeRequestQuery<T extends QueryRequest>(request: T): T {
  return { ...request, ...changeRequestParams(request, queryRows(request)) }
}
