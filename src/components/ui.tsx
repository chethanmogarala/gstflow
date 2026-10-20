import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Status } from '../engine/types'

export const STATUS: Record<Status, { label: string; cls: string }> = {
  matched: { label: 'Matched', cls: 'p-good' },
  probable: { label: 'Probable match', cls: 'p-warn' },
  only_in_register: { label: 'Only in register', cls: 'p-bad' },
  only_in_2b: { label: 'Only in 2B', cls: 'p-info' },
}

export function StatusPill({ status }: { status: Status }) {
  return <span className={`pill ${STATUS[status].cls}`}>{STATUS[status].label}</span>
}

export function Tile({ k, v, h, tone, money }: { k: string; v: ReactNode; h?: ReactNode; tone?: 'good' | 'warn' | 'bad'; money?: boolean }) {
  return (
    <div className={`tile ${tone ?? ''}`}>
      <span className="k">{k}</span>
      <span className={`v ${money ? 'money' : ''}`}>{v}</span>
      {h && <span className="h">{h}</span>}
    </div>
  )
}

export function Drawer({ title, onClose, children, head }: { title: string; onClose: () => void; children: ReactNode; head?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title}>
        <div className="drawer-head"><div>{head}</div><button className="x" onClick={onClose} aria-label="Close">×</button></div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  )
}

const ToastCtx = createContext<(msg: string) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = useCallback((m: string) => {
    setMsg(m)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMsg(null), 3200)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

export function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}
