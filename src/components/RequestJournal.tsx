import { useState } from 'react'
import type { RequestJournalEntry } from '../types/request'
import { displayHeaders } from '../services/requestJournal'
import { Modal } from './Modal'
import '../journal.css'

export function RequestJournal({ entries, onClose }: { entries: RequestJournalEntry[]; onClose: () => void }) {
  const [selected, setSelected] = useState(entries[0]?.id ?? '')
  const [reveal, setReveal] = useState(false)
  const entry = entries.find(e => e.id === selected) ?? entries[0]
  return <Modal title="Request log" onClose={onClose} wide>
    <p>The last 50 requests from this session, including Runner and OAuth. Explicit prepared headers are shown; automatic transport headers and browser redirect hops are not exposed.</p>
    {!entry ? <p className="config-hint">Send a request to see its resolved URL, headers, body, timings and errors here.</p> : <div className="journal-layout">
      <div className="journal-list" aria-label="Logged requests">{entries.map(e => <button type="button" key={e.id} className={entry.id === e.id ? 'active' : ''} onClick={() => setSelected(e.id)}><strong>{e.name}</strong><span>{new Date(e.startedAt).toLocaleTimeString()} · {e.state === 'complete' ? `${e.status} · ${e.duration} ms` : e.state}</span></button>)}</div>
      <div className="journal-detail" role="region" aria-label="Request log details">
        <div className="journal-meta"><strong>{entry.state === 'complete' ? `${entry.status} ${entry.statusText}` : entry.state}</strong><span>{entry.transport} · {entry.duration ?? '…'} ms total</span></div>
        {entry.headersDuration !== undefined && <p className="config-hint">Until response headers: {entry.headersDuration} ms · Body download: {entry.downloadDuration ?? 0} ms</p>}
        {entry.error && <p className="danger-text" role="alert">{entry.error}</p>}
        {entry.request ? <><h3>Prepared request</h3><pre>{entry.request.method} {entry.request.url}</pre><label className="check-label"><input type="checkbox" checked={reveal} onChange={e => setReveal(e.target.checked)} /> Show sensitive headers</label><pre>{displayHeaders(entry.request.headers, reveal)}</pre>
          {entry.request.body !== undefined && <><h3>Request body{entry.request.bodyTruncated ? ' (first 100 KiB)' : ''}</h3><pre>{entry.request.body || '(empty)'}</pre></>}
          {entry.request.binarySize !== undefined && <p>Binary request body · {entry.request.binarySize.toLocaleString()} bytes</p>}
        </> : <p>Validation failed before a request could be prepared.</p>}
        {entry.finalUrl && <><h3>Final response URL</h3><pre>{entry.finalUrl}</pre></>}
        {!!entry.redirects?.length && <><h3>Redirect chain</h3><ol className="journal-redirects">{entry.redirects.map((redirect, i) => <li key={i}><strong>{redirect.status}</strong><code>{redirect.from}</code><span>→</span><code>{redirect.to}</code></li>)}</ol></>}
        {entry.responseHeaders && <><h3>Response headers</h3><pre>{displayHeaders(entry.responseHeaders, reveal)}</pre></>}
      </div>
    </div>}
    <div className="modal-actions"><button type="button" className="save" onClick={onClose}>Close</button></div>
  </Modal>
}
