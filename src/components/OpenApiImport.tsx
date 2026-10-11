import { useState } from 'react'
import { Modal } from './Modal'
import { importOpenApi } from '../services/openApiImport'
import type { ImportResult } from '../services/postmanImport'
import '../openapi.css'

export function OpenApiImport({ onImport, onClose }: { onImport: (result: ImportResult) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.example.com')
  const [preview, setPreview] = useState<ImportResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const resetPreview = () => { setPreview(null); setError('') }
  const readFile = async (file?: File) => {
    if (!file) return
    resetPreview()
    if (file.size > 2 * 1024 * 1024) { setError('Specification is larger than 2 MiB.'); return }
    setLoading(true)
    try { setText(await file.text()) } catch { setError('Unable to read the selected file. Paste its JSON or YAML below.') } finally { setLoading(false) }
  }
  const createPreview = () => {
    try { setPreview(importOpenApi(text, { baseUrl })); setError('') } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <Modal title="Import OpenAPI / Swagger" onClose={onClose} wide>
    <div className="openapi-import">
      <p>Create a collection from Swagger 2.0 or OpenAPI 3.0/3.1. Choose a self-contained JSON or YAML document, or paste it below.</p>
      <label className="file-label">Specification file<input type="file" accept=".json,.yaml,.yml,application/json,text/yaml" aria-label="OpenAPI specification file" disabled={loading} onChange={e => { void readFile(e.target.files?.[0]); e.target.value = '' }} /></label>
      <textarea autoFocus className="import-text" aria-label="OpenAPI specification" placeholder={'openapi: 3.1.0\ninfo:\n  title: My API\n  version: 1.0.0\npaths: {}'} value={text} disabled={loading} onChange={e => { setText(e.target.value); resetPreview() }} />
      <label className="openapi-base">Fallback base URL<input type="url" aria-label="OpenAPI fallback base URL" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); resetPreview() }} /></label>
      <p className="openapi-hint">Used for relative or missing server URLs. Absolute servers declared in the specification keep their URL. Optional parameters without an example or default start disabled. Generated examples should be reviewed before sending.</p>
      <button className="save" disabled={loading || !text.trim()} onClick={createPreview}>{loading ? 'Reading file…' : 'Preview import'}</button>
      {error && <p role="alert" className="danger-text">{error}</p>}
      {preview && <div className="import-preview openapi-preview">
        <label>Collection name<input aria-label="OpenAPI collection name" value={preview.collection.name} onChange={e => setPreview({ ...preview, collection: { ...preview.collection, name: e.target.value } })} /></label>
        <div className="openapi-stats"><span><strong>{preview.requests.length}</strong> requests</span><span><strong>{preview.collection.folders?.length ?? 0}</strong> tag folders</span><span><strong>{preview.requests.filter(r => r.responseSchema).length}</strong> response schemas</span><span><strong>{preview.skipped}</strong> skipped</span></div>
        <ul className="import-requests">{preview.requests.slice(0, 30).map(request => <li key={request.id}><span className={`openapi-method ${request.method.toLowerCase()}`}>{request.method}</span><div><strong>{request.name}</strong><code>{request.url}</code></div></li>)}{preview.requests.length > 30 && <li>… and {preview.requests.length - 30} more requests</li>}</ul>
        {preview.warnings.length > 0 && <details><summary>{preview.warnings.length} import warnings — review before importing</summary><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        {!preview.requests.length && <p>No supported requests were found in paths.</p>}
      </div>}
      <div className="modal-actions"><button className="save" onClick={onClose}>Cancel</button><button className="send" disabled={!preview?.requests.length || !preview.collection.name.trim() || loading} onClick={() => {
        if (!preview) return
        try { onImport(preview) }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      }}>Import collection</button></div>
    </div>
  </Modal>
}
