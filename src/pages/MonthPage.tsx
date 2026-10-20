// One page per client per month: Upload → Fix issues → Send & close.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { errorText, useToast } from '../components/ui'
import { currentReturnPeriod, dueDate, inr, nextPeriod, periodLabel, previousPeriod } from '../engine/format'
import { RULES } from '../engine/reconcile'
import { loadAudit, loadRows } from '../lib/data'
import { db } from '../lib/supabase'
import { openCount } from '../lib/todo'
import type { AuditEntry, Client, Period, Row } from '../lib/types'
import CloseStep from './CloseStep'
import FixStep from './FixStep'
import UploadStep from './UploadStep'

export type Step = 'upload' | 'fix' | 'close'

export function itcAtRisk(rows: Row[]) {
  return rows.reduce((s, r) => s
    + (r.status === 'only_in_register' && r.rule !== RULES.rcm && r.rule !== 'Added by staff' ? r.reg?.tax ?? 0 : 0)
    + (r.b2b && r.risks.some(x => x.type === 'Blocked 17(5)') ? r.b2b.tax : 0), 0)
}

export function itcSafe(rows: Row[]) {
  return rows.reduce((s, r) => s + (r.status === 'matched' || r.decision === 'Confirmed match' || r.mark === 'have' ? (r.b2b ?? r.reg)?.tax ?? 0 : 0), 0)
}

export default function MonthPage() {
  const { clientId, period: periodParam } = useParams()
  const nav = useNavigate()
  const toast = useToast()
  const [client, setClient] = useState<Client | null>(null)
  const [period, setPeriod] = useState<Period | null | undefined>(undefined)
  const [rows, setRows] = useState<Row[]>([])
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([])
  const [step, setStep] = useState<Step | null>(null)

  const month = periodParam && /^(0[1-9]|1[0-2])\d{4}$/.test(periodParam) ? periodParam : null

  const load = useCallback(async () => {
    if (!month) return
    const [{ data: c }, { data: p }] = await Promise.all([
      db().from('clients').select('*').eq('id', clientId).single(),
      db().from('periods').select('*').eq('client_id', clientId).eq('period', month).maybeSingle(),
    ])
    setClient(c)
    setPeriod(p ?? null)
    if (p?.run_at) {
      const [r, a] = await Promise.all([loadRows(p.id), loadAudit(p.id)])
      setRows(r)
      setAuditLog(a)
      return { p, r }
    }
    setRows([])
    setAuditLog([])
    return { p, r: [] as Row[] }
  }, [clientId, month])

  useEffect(() => {
    setStep(null)
    load().then(res => {
      if (!res) return
      setStep(!res.p?.run_at ? 'upload' : openCount(res.r) > 0 ? 'fix' : 'close')
    }).catch(e => toast(errorText(e)))
  }, [load, toast])

  const refreshAudit = useCallback(async () => { if (period) setAuditLog(await loadAudit(period.id)) }, [period])
  const open = useMemo(() => openCount(rows), [rows])

  if (!month) return <Navigate to={`/clients/${clientId}/${currentReturnPeriod()}`} replace />
  if (!client || period === undefined || !step) return <div className="empty">Loading…</div>

  const ran = !!period?.run_at
  const noRegister = ran && !period!.register_file
  const final = period?.status === 'final'
  const go = (p: string) => nav(`/clients/${client.id}/${p}`)

  const steps: { key: Step; n: number; title: string; note: string; done: boolean; disabled?: boolean }[] = [
    { key: 'upload', n: 1, title: 'Upload', note: ran ? (noRegister ? `${rows.filter(r => r.b2b).length} invoices from 2B` : `${period!.register_file}`) : 'Purchase register and GSTR-2B', done: ran },
    { key: 'fix', n: 2, title: 'Fix issues', note: !ran ? 'After upload' : open ? `${open} left` : 'All sorted', done: ran && open === 0, disabled: !ran },
    { key: 'close', n: 3, title: 'Send & close', note: final ? 'Closed' : 'Messages and downloads', done: final, disabled: !ran },
  ]

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow"><Link to="/">Clients</Link> · <span className="mono">{client.gstin}</span> · <Link to={`/clients/${client.id}/settings`}>Client settings</Link></div>
          <h1>{client.name}</h1>
          <p className="sub">{periodLabel(month)} · GSTR-3B due {dueDate(month)}{ran && rows.length > 0 && <> · ITC you may lose <b className="num" style={{ color: 'var(--bad)' }}>{inr(itcAtRisk(rows))}</b></>}</p>
        </div>
        <div className="month-switch" aria-label="Change month">
          <button className="btn sm" onClick={() => go(previousPeriod(month))} aria-label="Previous month">‹</button>
          <span>{periodLabel(month)}</span>
          <button className="btn sm" onClick={() => go(nextPeriod(month))} aria-label="Next month">›</button>
        </div>
      </div>

      <ol className="stepper">
        {steps.map(s => (
          <li key={s.key}>
            <button className={`${step === s.key ? 'on' : ''} ${s.done ? 'done' : ''}`} disabled={s.disabled} onClick={() => setStep(s.key)} aria-label={`Step ${s.n}: ${s.title}, ${s.note}`} aria-current={step === s.key ? 'step' : undefined}>
              <span className="n">{s.done ? '✓' : s.n}</span>
              <span><b>{s.title}</b><small>{s.note}</small></span>
            </button>
          </li>
        ))}
      </ol>

      {step === 'upload' && (
        <UploadStep client={client} month={month} period={period} final={final}
          onDone={async () => { const res = await load(); setStep(res && openCount(res.r) ? 'fix' : 'close') }} />
      )}
      {step === 'fix' && period && (
        <FixStep client={client} period={period} rows={rows} setRows={setRows} final={final} noRegister={noRegister}
          onAudit={refreshAudit} onNext={() => setStep('close')} />
      )}
      {step === 'close' && period && (
        <CloseStep client={client} period={period} rows={rows} auditLog={auditLog} open={open} noRegister={noRegister}
          onAudit={refreshAudit} onBack={() => setStep('fix')} onChange={load} />
      )}
    </>
  )
}
