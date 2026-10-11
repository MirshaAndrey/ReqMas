import { useLayoutEffect, useRef, useState } from 'react'
import type { Assertion, FileBody, Pair, Request } from '../types/request'
import { PairEditor } from './PairEditor'
import { JsonBodyEditor } from './JsonBodyEditor'
import { bytesBase64 } from '../services/responseEncoding'
async function readFile(file: File): Promise<FileBody> {
  if (file.size > 10 * 1024 * 1024) throw new Error('Maximum attachment size is 10 MB.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  return { name: file.name, type: file.type, base64: bytesBase64(bytes) }
}
export function BodyEditor({ request: r, update, busy, onError, onReading, variables = [] }: { request: Request; update: (v: Partial<Request> | ((current: Request) => Partial<Request>)) => void; busy: boolean; onError: (s: string) => void; onReading?: (reading: boolean) => void; variables?: Pair[] }) {
  const reads = useRef(0), activeRead = useRef(false)
  const [reading, setReading] = useState(false)
  useLayoutEffect(() => () => { reads.current++; activeRead.current = false; setReading(false); onReading?.(false) }, [r.id, r.bodyType, onReading])
  const load = async (files: File[], mode: 'binary' | 'formdata') => {
    if (!files.length || activeRead.current || busy) return
    const token = ++reads.current, requestId = r.id
    activeRead.current = true; setReading(true); onReading?.(true)
    try {
      // Wait for every reader, even if one fails; no partial upload is silently committed.
      const results = await Promise.allSettled(files.map(readFile))
      if (reads.current !== token) return
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      const data = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      update(current => current.id !== requestId || current.bodyType !== mode ? {} : mode === 'binary' ? { binary: data[0] } : { files: [...(current.files ?? []), ...data.map(file => ({ ...file, id: crypto.randomUUID(), key: 'file', enabled: true }))] })
    } catch (error) { if (reads.current === token) onError(error instanceof Error ? error.message : String(error)) }
    finally { if (reads.current === token) { activeRead.current = false; setReading(false); onReading?.(false) } }
  }
  const disabled = busy || reading
  return <><div className="body-options">{(['none', 'json', 'text', 'xml', 'urlencoded', 'formdata', 'binary'] as const).map(t => <label key={t}><input disabled={disabled} type="radio" name="body-type" checked={r.bodyType === t} onChange={() => update({ bodyType: t })} />{t === 'urlencoded' ? 'URL encoded' : t === 'formdata' ? 'Form data' : t.toUpperCase()}</label>)}</div>
    {r.bodyType === 'json' && <JsonBodyEditor value={r.body} onChange={body => update({ body })} variables={variables} disabled={busy} />}
    {['text', 'xml'].includes(r.bodyType) && <textarea disabled={busy} aria-label="Request body" className="body-editor" spellCheck={false} value={r.body} onChange={e => update({ body: e.target.value })} />}
    {['urlencoded', 'formdata'].includes(r.bodyType) && <PairEditor label="form field" rows={r.form ?? []} onChange={form => update({ form })} disabled={busy} />}
    {r.bodyType === 'formdata' && <><label className="attachment">Attach files<input type="file" multiple disabled={disabled} aria-label="Multipart files" onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; void load(files, 'formdata') }} /></label>{r.files?.map(f => <div className="tool-row" key={f.id}><input disabled={disabled} type="checkbox" aria-label={`Enable file ${f.name}`} checked={f.enabled} onChange={e => update({ files: r.files!.map(old => old.id === f.id ? { ...old, enabled: e.target.checked } : old) })} /><input disabled={disabled} aria-label={`File field ${f.name}`} value={f.key} onChange={e => update({ files: r.files!.map(old => old.id === f.id ? { ...old, key: e.target.value } : old) })} /><span>{f.name}</span><button disabled={disabled} aria-label={`Remove file ${f.name}`} onClick={() => update({ files: r.files!.filter(old => old.id !== f.id) })}>×</button></div>)}</>}
    {r.bodyType === 'binary' && <label className="attachment">{r.binary?.name ?? 'Choose binary file'}<input disabled={disabled} type="file" aria-label="Binary file" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void load([file], 'binary') }} /></label>}
    {reading && <p className="config-hint" role="status">Reading file…</p>}
    {r.bodyType === 'none' && <p className="body-empty">This request has no body.</p>}
    {['GET', 'HEAD'].includes(r.method) && r.bodyType !== 'none' && <p className="config-hint">GET and HEAD are sent without a body.</p>}
  </>
}
export function TestsEditor({ tests, onChange, disabled }: { tests: Assertion[]; onChange: (v: Assertion[]) => void; disabled: boolean }) {
  const update = (id: string, change: Partial<Assertion>) => onChange(tests.map(t => t.id === id ? { ...t, ...change } : t))
  return <><p className="config-hint">Checks run after every response and in the collection runner. JSON paths use dots, e.g. users.0.id. Expected JSON values are written as JSON; strings without quotes.</p>{tests.map(t => <div className="assertion-row" key={t.id}><input disabled={disabled} type="checkbox" aria-label="Enable assertion" checked={t.enabled} onChange={e => update(t.id, { enabled: e.target.checked })} /><select disabled={disabled} aria-label="Assertion type" value={t.kind} onChange={e => update(t.id, { kind: e.target.value as Assertion['kind'] })}><option value="status">Status equals</option><option value="duration">Time ≤ ms</option><option value="contains">Body contains</option><option value="header">Header equals</option><option value="json">JSON path equals</option></select>{['header', 'json'].includes(t.kind) && <input disabled={disabled} aria-label="Assertion key" value={t.key} placeholder={t.kind === 'json' ? 'users.0.id' : 'content-type'} onChange={e => update(t.id, { key: e.target.value })} />}<input disabled={disabled} aria-label="Expected value" value={t.expected} onChange={e => update(t.id, { expected: e.target.value })} placeholder="Expected value" /><button disabled={disabled} aria-label="Remove assertion" onClick={() => onChange(tests.filter(old => old.id !== t.id))}>×</button></div>)}<button className="save" disabled={disabled} onClick={() => onChange([...tests, { id: crypto.randomUUID(), kind: 'status', key: '', expected: '200', enabled: true }])}>+ Add assertion</button></>
}
