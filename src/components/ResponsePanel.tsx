import { useMemo, useState } from 'react'
import type { AssertionResult, History, Response } from '../types/request'
import { ResponseCode } from './ResponseCode'
import { diffResponses, flattenJsonTree, formatResponseJson, isExactJsonNumber, parseResponseJson, responseBytes, responseFileName, responseImageSource, responseKind, responseMediaType, stringifyResponseValue, valueSummary } from '../services/responseView'
import '../response.css'

type Props = { response: Response | null; error: string; busy: boolean; assertions: AssertionResult[]; history: History[]; comparisonResponses?: { id: string; name: string; response: Response }[]; view: string; onView: (view: string) => void; search: string; onSearch: (search: string) => void; match: number; onMatch: (match: number | ((n: number) => number)) => void; onNotice: (notice: string) => void }
function copyText(text: string, label: string, onNotice: Props['onNotice']) { void navigator.clipboard.writeText(text).then(() => onNotice(`${label} copied`), () => onNotice('Unable to access clipboard')) }
function JsonTree({ value, onNotice }: { value: unknown; onNotice: Props['onNotice'] }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [offset, setOffset] = useState(0)
  const [previousValue, setPreviousValue] = useState(value)
  if (previousValue !== value) { setPreviousValue(value); setExpanded(new Set([''])); setOffset(0) }
  const tree = useMemo(() => flattenJsonTree(value, expanded, 1000, 64, offset), [value, expanded, offset])
  const toggle = (path: string) => { setOffset(0); setExpanded(old => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next }) }
  const copyValue = (value: unknown) => { try { copyText(typeof value === 'string' ? value : stringifyResponseValue(value), 'Value', onNotice) } catch { onNotice('This value is too deeply nested to copy. Save the response instead.') } }
  return <div className="json-tree-view"><div className="response-subtools"><span>JSON tree · Nodes {offset + 1}–{offset + tree.rows.length}</span><div><button onClick={() => { setOffset(0); setExpanded(old => new Set([...old, ...tree.rows.filter(row => row.expandable).map(row => row.path)])) }}>Expand one level</button><button onClick={() => { setOffset(0); setExpanded(new Set()) }}>Collapse all</button><button disabled={!offset} onClick={() => setOffset(n => Math.max(0, n - 1000))}>Previous nodes</button><button disabled={!tree.hasMore} onClick={() => setOffset(n => n + 1000)}>Next nodes</button></div></div><div className="json-tree" role="tree" aria-label="Response JSON tree">
    {tree.rows.map(row => <div key={row.path} className="json-tree-row" role="treeitem" aria-level={row.depth + 1} aria-expanded={row.expandable ? row.expanded : undefined} style={{ paddingLeft: 16 + Math.min(row.depth, 20) * 18 }}>
      <button className="tree-toggle" disabled={!row.expandable} aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.path || 'root'}`} onClick={() => toggle(row.path)}>{row.expandable ? row.expanded ? '▾' : '▸' : '·'}</button><span className="tree-key">{row.key}</span><span className={`tree-value tree-${isExactJsonNumber(row.value) ? 'number' : row.value === null ? 'null' : typeof row.value}`}>{valueSummary(row.value)}</span><div className="tree-actions"><button title="Copy value" aria-label={`Copy value at ${row.path || 'root'}`} onClick={() => copyValue(row.value)}>Value</button><button title={row.path || 'Root JSON pointer (empty string)'} aria-label={`Copy JSON pointer for ${row.path || 'root'}`} onClick={() => copyText(row.path, 'JSON pointer', onNotice)}>Path</button></div>
    </div>)}
  </div>{tree.truncated && <p className="response-warning">Showing up to 1,000 nodes per page and 64 levels. Use Next nodes to view the remaining fields.</p>}</div>
}
function CompareResponse({ response, candidates }: { response: Response; candidates: { id: string; name: string; response: Response }[] }) {
  const [selected, setSelected] = useState('')
  const chosen = candidates.find(c => c.id === selected) ?? candidates[0]
  const comparison = useMemo(() => chosen ? diffResponses(chosen.response, response) : undefined, [chosen, response])
  return <div className="response-compare"><label className="response-subtools">Compare with<select aria-label="Response comparison baseline" value={chosen?.id ?? ''} onChange={e => setSelected(e.target.value)}>{!candidates.length && <option value="">No saved responses</option>}{candidates.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label><p className="response-explanation">Before: selected response → After: current response. Compares bodies; JSON object key order is ignored. Paths use JSON Pointer.</p>
    {!comparison ? <div className="response-message">Send another request or open a history response to compare bodies.</div> : comparison.error ? <div className="response-warning">{comparison.error}</div> : <><div className="response-diff-summary">{comparison.equal ? '✓ Bodies are identical' : `${comparison.changes.length}${comparison.truncated ? '+' : ''} differences`} · {comparison.kind.toUpperCase()} comparison</div>{comparison.changes.length > 0 && <div className="response-diff-table" role="table" aria-label="Response body differences"><div className="response-diff-head" role="row"><span>Change / path</span><span>Before</span><span>After</span></div>{comparison.changes.map((change, i) => <div className={`response-diff-row diff-${change.kind}`} role="row" key={i}><span><strong>{change.kind}</strong><code>{change.path || '(root)'}</code></span><code title={Object.hasOwn(change, 'before') ? valueSummary(change.before, 2000) : ''}>{Object.hasOwn(change, 'before') ? valueSummary(change.before, 1000) : '—'}</code><code title={Object.hasOwn(change, 'after') ? valueSummary(change.after, 2000) : ''}>{Object.hasOwn(change, 'after') ? valueSummary(change.after, 1000) : '—'}</code></div>)}</div>}{comparison.truncated && <p className="response-warning">Comparison is bounded to 200 differences and 10,000 JSON nodes. Additional differences may exist.</p>}</>}
  </div>
}
export function ResponsePanel(p: Props) {
  const { response, view, search, match, onNotice } = p
  const parsed = useMemo(() => response ? parseResponseJson(response) : undefined, [response])
  const kind = response ? responseKind(response) : ''
  const emptyBody = !!response && response.size === 0 && response.body === '' && !response.bodyTruncated
  const fullText = useMemo(() => {
    if (!response) return ''
    if (view === 'Headers') return Object.entries(response.headers).flatMap(([key, value]) => value.split('\n').map(part => `${key}: ${part}`)).join('\n')
    if (response.binary) return `Binary response · ${response.size.toLocaleString()} bytes\nSave response to download the original file.`
    if (view === 'Pretty' && parsed?.ok) { try { return formatResponseJson(response.body) } catch { return response.body } }
    return response.body
  }, [response, view, parsed])
  const text = useMemo(() => fullText.slice(0, 500000).split('\n').slice(0, 2000).join('\n'), [fullText])
  const textView = ['Pretty', 'Raw', 'Headers'].includes(view)
  const imageSource = response && view === 'Pretty' ? responseImageSource(response) : undefined
  const searchable = textView && !imageSource && (!response?.binary || view === 'Headers')
  const matchingLines = useMemo(() => search && searchable ? text.split('\n').flatMap((line, i) => line.toLowerCase().includes(search.toLowerCase()) ? [i] : []) : [], [text, search, searchable])
  const matchIndex = matchingLines.length ? (match % matchingLines.length + matchingLines.length) % matchingLines.length : 0
  const candidates = useMemo(() => [...(p.comparisonResponses ?? []).map(c => ({ ...c, id: `tab:${c.id}`, name: `Tab · ${c.name}` })), ...p.history.filter(h => h.response).map(h => ({ id: `history:${h.id}`, name: `History · ${h.request.name} · ${h.time}`, response: { ...h.response!, bodyTruncated: h.bodyTruncated || h.response!.bodyTruncated } }))], [p.comparisonResponses, p.history])
  const saveResponse = () => {
    if (!response) return
    try {
      const blob = new Blob([responseBytes(response)], { type: responseMediaType(response) || 'application/octet-stream' })
      const url = URL.createObjectURL(blob), anchor = document.createElement('a')
      anchor.href = url; anchor.download = responseFileName(response); document.body.append(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30000)
      onNotice(`Saving ${anchor.download}`)
    } catch (e) { onNotice(e instanceof Error ? e.message : 'Unable to save response') }
  }
  return <section className="response-panel advanced-response"><div className="response-heading"><h2>Response <span className="count">{response ? '1' : '0'}</span></h2>{response ? <div className="response-meta"><span className={response.status < 400 ? 'status-good' : 'status-bad'}>● {response.status} {response.statusText}</span><span>◷ {response.duration} ms</span><span>↓ {(response.size / 1024).toFixed(2)} KB</span></div> : <span className="muted">Waiting for a request</span>}</div>
    <div className="response-toolbar"><div className="response-view-tabs">{['Pretty', 'Raw', 'Tree', 'Headers', 'Compare'].map(v => <button className={view === v ? 'active' : ''} key={v} onClick={() => p.onView(v)}>{v}</button>)}</div><div className="response-tools"><input disabled={!textView || !!imageSource || !!response?.binary && view !== 'Headers'} type="search" aria-label="Search response" placeholder="Find in response…" value={search} onChange={e => { p.onSearch(e.target.value); p.onMatch(0) }} /><span>{textView && search ? `${matchingLines.length ? matchIndex + 1 : 0}/${matchingLines.length}` : ''}</span><button disabled={!textView || !matchingLines.length} aria-label="Previous match" onClick={() => p.onMatch(i => (i - 1 + matchingLines.length) % matchingLines.length)}>↑</button><button disabled={!textView || !matchingLines.length} aria-label="Next match" onClick={() => p.onMatch(i => (i + 1) % matchingLines.length)}>↓</button><span>{view === 'Headers' && response ? 'HEADERS' : kind}</span><button disabled={!response || !!response.binary && view !== 'Headers'} title="Copy response" aria-label="Copy response" onClick={() => copyText(fullText, 'Response', onNotice)}>▢</button><button disabled={!response || response.bodyTruncated || response.binary && response.bodyBase64 === undefined} title={response?.bodyTruncated ? 'History snapshot is incomplete. Send the request again.' : 'Save original response bytes'} onClick={saveResponse}>Save response ↓</button></div></div>
    {p.error ? <div className="error" role="alert"><strong>Request failed</strong><p>{p.error}</p></div> : response ? <>
      {response.bodyTruncated && <p className="response-warning">This history body was truncated. Send the request again to view and save the full response.</p>}
      {emptyBody && ['Pretty', 'Raw', 'Tree'].includes(view) ? <div className="response-message">No response body.</div> : view === 'Tree' ? parsed?.ok ? <JsonTree key={`${response.url}-${response.duration}-${response.size}`} value={parsed.value} onNotice={onNotice} /> : <div className="response-message">{parsed && !parsed.ok ? parsed.reason : 'No JSON body available.'}</div> : view === 'Compare' ? <CompareResponse response={response} candidates={candidates} /> : imageSource ? <div className="response-image"><img src={imageSource} alt="Response image preview" /><span>{responseMediaType(response)} · Original bytes preserved for download</span></div> : <>{view === 'Pretty' && kind === 'JSON' && parsed && !parsed.ok && <p className="response-warning">{parsed.reason} Showing raw text.</p>}<ResponseCode text={text} search={search} activeLine={matchingLines[matchIndex]} language={view === 'Headers' ? 'headers' : view === 'Pretty' && parsed?.ok ? 'json' : 'text'} />{text !== fullText && <p className="response-warning">Display limited to 2,000 lines / 500,000 characters. Copy or save the response to get the full body.</p>}</>}
    </> : <div className="empty-response"><div className="empty-icon" aria-hidden="true">&gt;_</div><h3>{p.busy ? 'Sending your request…' : 'Your next response starts here'}</h3><p>{p.busy ? 'Waiting for the server to respond.' : 'Send a request to see the status, headers, and body.'}</p><span className="empty-note">Make something great. One request at a time.</span></div>}
    {response && p.assertions.length > 0 && <div className="assertion-results">{p.assertions.map((t, i) => <details key={i} className={t.passed ? 'status-good' : 'status-bad'}><summary>{t.passed ? '✓' : '×'} {t.name}</summary><p>{t.actual}</p></details>)}</div>}
  </section>
}
