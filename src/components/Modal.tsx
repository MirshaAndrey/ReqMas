import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  return <dialog className={`modal ${wide ? 'modal-wide' : ''}`} ref={ref} aria-label={title} onCancel={e => { e.preventDefault(); onClose() }}>
    <div className="modal-heading"><h2>{title}</h2><button type="button" aria-label="Close dialog" onClick={onClose}>×</button></div>
    {children}
  </dialog>
}
