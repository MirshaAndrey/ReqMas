import { useRef, useState } from 'react'
import type { KeyboardEvent, SyntheticEvent } from 'react'
import type { Pair } from '../types/request'
import { highlightJsonLine } from '../utils/responseHighlight'
type Props = { value: string; onChange: (value: string) => void; variables: Pair[]; label: string; disabled?: boolean; multiline?: boolean; highlight?: boolean; placeholder?: string }
export function TemplateEditor({ value, onChange, variables, label, disabled, multiline, highlight, placeholder }: Props) {
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null); const paint = useRef<HTMLPreElement>(null)
  const [cursor, setCursor] = useState(0); const [index, setIndex] = useState(0); const [dismissed, setDismissed] = useState(true)
  const prefix = value.slice(0, cursor); const start = prefix.lastIndexOf('{{'); const part = prefix.slice(start + 2)
  const candidates = !disabled && !dismissed && start >= 0 && /^[\p{L}\p{N}_.-]*$/u.test(part) ? Array.from(new Set(variables.filter(v => v.enabled && v.key).map(v => v.key))).filter(key => key.toLowerCase().includes(part.toLowerCase())).slice(0, 8) : []
  const insert = (text: string, from = ref.current?.selectionStart ?? cursor, to = ref.current?.selectionEnd ?? cursor) => { onChange(value.slice(0, from) + text + value.slice(to)); const end = from + text.length; setCursor(end); setDismissed(true); requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(end, end) }) }
  const choose = (key: string) => insert('{{' + key + '}}', start, cursor + (value.slice(cursor, cursor + 2) === '}}' ? 2 : 0))
  const keyDown = (e: KeyboardEvent) => { if (candidates.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) { e.preventDefault(); if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setIndex(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); else choose(candidates[index % candidates.length]) } else if (e.key === 'Escape') setDismissed(true); else if (multiline && e.key === 'Tab') { e.preventDefault(); insert('  ') } }
  const props = { value, disabled, placeholder, 'aria-label': label, spellCheck: false, onKeyDown: keyDown, onSelect: (e: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => setCursor(e.currentTarget.selectionStart ?? 0), onChange: (e: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => { onChange(e.currentTarget.value); setCursor(e.currentTarget.selectionStart ?? 0); setDismissed(false); setIndex(0) }, onBlur: () => setDismissed(true) }
  return <div className={`template-editor ${multiline ? 'multiline' : ''} ${highlight ? 'highlighted' : ''}`}>
    {highlight && <pre ref={paint} className="json-highlight response-code" aria-hidden="true">{value.split('\n').map((line, i) => <span key={i}>{highlightJsonLine(line).map((token, j) => <span key={j} className={`syntax-${token.kind}`}>{token.text}</span>)}{'\n'}</span>)}</pre>}
    {multiline ? <textarea {...props} ref={el => { ref.current = el }} onScroll={e => { if (paint.current) { paint.current.scrollTop = e.currentTarget.scrollTop; paint.current.scrollLeft = e.currentTarget.scrollLeft } }} /> : <input {...props} ref={el => { ref.current = el }} />}
    {candidates.length > 0 && <div className="variable-suggestions" role="listbox" aria-label="Variable suggestions">{candidates.map((key, i) => <button type="button" key={key} role="option" aria-selected={i === index % candidates.length} onMouseDown={e => e.preventDefault()} onClick={() => choose(key)}>{'{{' + key + '}}'}</button>)}</div>}
  </div>
}
