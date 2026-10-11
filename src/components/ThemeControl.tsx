import { useEffect, useState } from 'react'
import { applyTheme, getTheme } from '../theme'
import type { Theme } from '../theme'
import { write } from '../storage/database'

export function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(getTheme)

  useEffect(() => {
    applyTheme(theme)
    try { write('theme', theme) } catch { /* Theme still works when local storage is unavailable. */ }
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => { if (theme === 'system') applyTheme(theme) }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  return <label className="theme-control" title="Color theme">
    <span aria-hidden="true">{theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}</span>
    <select aria-label="Color theme" value={theme} onChange={e => setTheme(e.target.value as Theme)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
}
