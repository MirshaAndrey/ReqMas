import { useState } from 'react'
import type { Pair } from '../types/request'
import { formatJsonTemplate } from '../services/jsonEditor'
import { resolveVariables } from '../services/prepareRequest'
import { ResponseCode } from './ResponseCode'
import { TemplateEditor } from './TemplateEditor'
import { formatResponseJson } from '../services/responseView'
export function JsonBodyEditor({ value, onChange, variables, disabled }: { value: string; onChange: (value: string) => void; variables: Pair[]; disabled: boolean }) {
  const [preview, setPreview] = useState(false); let formatted = ''; let error = ''
  if (value.trim()) try { formatted = formatJsonTemplate(value) } catch (e) { error = e instanceof Error ? e.message : String(e) }
  let resolved = ''; let resolveError = ''
  if (preview && !error) try { resolved = formatResponseJson(resolveVariables(value, variables)) } catch (e) { resolveError = e instanceof Error ? e.message : String(e) }
  return <div className="json-editor"><div className="tool-row"><button className="save" disabled={disabled || !formatted || !!error} onClick={() => onChange(formatted)}>Format JSON</button><button className="save" onClick={() => setPreview(!preview)}>{preview ? 'Hide resolved body' : 'Show resolved body'}</button><span className={error ? 'danger-text' : 'status-good'}>{error ? 'Invalid JSON' : value.trim() ? 'Valid JSON template' : 'Empty body'}</span></div>
    <TemplateEditor value={value} onChange={onChange} variables={variables} label="Request body" disabled={disabled} multiline highlight />
    {error && <p className="json-error danger-text" role="alert">{error}</p>}<p className="config-hint">Type {'{{'} for variable suggestions. Tab inserts two spaces. Formatting keeps your variable templates.</p>
    {preview && !error && <div className="resolved-preview"><p>Resolved body · current environment and variable values</p>{resolveError ? <p role="alert" className="danger-text">{resolveError}</p> : <ResponseCode text={resolved} language="json" label="Resolved request body" />}</div>}
  </div>
}
