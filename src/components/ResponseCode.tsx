import { useEffect, useMemo, useRef } from 'react'
import { highlightHeaderLine, highlightJsonLine } from '../utils/responseHighlight'

export function ResponseCode({ text, language, search = '', activeLine, label = 'Response body' }: { text: string; language: 'json' | 'headers' | 'text'; search?: string; activeLine?: number; label?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.querySelector('.active-match')?.scrollIntoView({ block: 'nearest' }) }, [activeLine, search, text])
  const lines = useMemo(() => text.split('\n').map(line => language === 'json' ? highlightJsonLine(line) : language === 'headers' ? highlightHeaderLine(line) : [{ text: line, kind: 'text' }]), [text, language])
  return <div ref={ref} className={`code-view response-code language-${language}`} role="region" aria-label={label} tabIndex={0}>
    {lines.map((tokens, i) => <div className={`code-line ${search && tokens.map(t => t.text).join('').toLowerCase().includes(search.toLowerCase()) ? 'search-match' : ''} ${i === activeLine ? 'active-match' : ''}`} key={i}>
      <span className="line-number" aria-hidden="true">{i + 1}</span>
      <code>{tokens.length ? tokens.map((token, j) => <span className={`syntax-${token.kind}`} key={j}>{token.text}</span>) : ' '}</code>
    </div>)}
  </div>
}
