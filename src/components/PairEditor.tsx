import type { Pair } from '../types/request'

export function PairEditor({ rows, onChange, label, disabled = false, allowSecrets = false }: { rows: Pair[]; onChange: (rows: Pair[]) => void; label: string; disabled?: boolean; allowSecrets?: boolean }) {
  const update = (id: string, change: Partial<Pair>) => onChange(rows.map(row => row.id === id ? { ...row, ...change } : row))
  return <div className={`kv-table${allowSecrets ? ' kv-secret-table' : ''}`}>
    <div className="kv-row table-head"><span /><span>KEY</span><span>VALUE</span>{allowSecrets && <span>SECRET</span>}<span /></div>
    {rows.map(row => <div className="kv-row" key={row.id}>
      <input disabled={disabled} aria-label={`Enable ${label}`} type="checkbox" checked={row.enabled} onChange={e => update(row.id, { enabled: e.target.checked })} />
      <input disabled={disabled} aria-label={`${label} key`} placeholder="Key" value={row.key} onChange={e => update(row.id, { key: e.target.value })} />
      <input disabled={disabled} aria-label={`${label} value`} placeholder="Value" type={row.secret ? 'password' : 'text'} autoComplete="off" value={row.value} onChange={e => update(row.id, { value: e.target.value })} />
      {allowSecrets && <input disabled={disabled} aria-label={`Secret ${label}${row.key ? ` ${row.key}` : ''}`} title="Hide value and exclude it from exports unless Include secrets is enabled" type="checkbox" checked={row.secret === true} onChange={e => update(row.id, { secret: e.target.checked })} />}
      <button disabled={disabled} aria-label={`Delete ${label}`} onClick={() => onChange(rows.filter(r => r.id !== row.id))} type="button">×</button>
    </div>)}
    <button disabled={disabled} className="add-row" type="button" onClick={() => onChange([...rows, { id: crypto.randomUUID(), key: '', value: '', enabled: true }])}>+ Add {label}</button>
  </div>
}
