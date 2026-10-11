import { useMemo, useState } from 'react'
import { checkResponseSchema, inferResponseSchema, validateResponseSchema } from '../services/schemaValidation'
import { formatResponseJson } from '../services/responseView'
import { TemplateEditor } from './TemplateEditor'
import '../runner.css'

export function SchemaEditor({ schema, onChange, disabled, inferredSample }: { schema: string; onChange: (value: string) => void; disabled: boolean; inferredSample?: string }) {
  const checked = useMemo(() => checkResponseSchema(schema), [schema])
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState(false)
  const attempt = (action: () => string, success: string) => {
    try { onChange(action()); setNotice(success); setPreview(false) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const sampleResults = preview && inferredSample !== undefined ? validateResponseSchema(schema, { body: inferredSample, status: 200, statusText: '', headers: {}, duration: 0, size: 0 }) : []
  return <div className="schema-editor">
    <p className="config-hint">Validate the response JSON automatically after Send and in the collection runner. An empty schema disables this check.</p>
    <div className="tool-row">
      <button className="save" disabled={disabled || checked.empty} onClick={() => attempt(() => formatResponseJson(schema), 'Schema formatted')}>Format schema</button>
      <button className="save" disabled={disabled || !inferredSample} onClick={() => attempt(() => inferResponseSchema(inferredSample!), 'Starter schema created. Review required fields and array item types before saving.')}>Generate from response</button>
      <button className="save" disabled={checked.empty || !checked.valid || inferredSample === undefined} onClick={() => setPreview(!preview)}>{preview ? 'Hide check' : 'Check current response'}</button>
      <span className={checked.valid ? 'status-good' : 'danger-text'}>{checked.empty ? 'No schema' : checked.valid ? `Valid draft ${checked.draft} schema` : 'Invalid schema'}</span>
    </div>
    <TemplateEditor value={schema} onChange={value => { onChange(value); setNotice(''); setPreview(false) }} variables={[]} label="Response JSON Schema" disabled={disabled} multiline highlight placeholder={'{\n  "type": "object",\n  "required": ["id"],\n  "properties": { "id": { "type": "integer" } }\n}'} />
    {!checked.valid && <p role="alert" className="json-error danger-text">{checked.error}</p>}
    {notice && <p className="config-hint" role="status">{notice}</p>}
    <p className="config-hint">Draft-07 is the default; use $schema for 2020-12. Local $ref is supported. Remote references and dynamic references are unavailable. Validation preserves response values.</p>
    {preview && <div className="schema-preview">{sampleResults.map((result, index) => <p className={result.passed ? 'status-good' : 'danger-text'} key={index}>{result.passed ? '✓' : '×'} {result.name} · {result.actual}</p>)}</div>}
  </div>
}
