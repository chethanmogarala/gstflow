import { useState, type ReactNode } from 'react'
import { copyText, errorText, Hint, useToast } from '../components/ui'
import { inr, periodLabel } from '../engine/format'
import { audit } from '../lib/data'
import { supplierGroups, supplierMessage } from '../lib/explain'
import { exportIms, exportReconciliation, exportRegister } from '../lib/exportXlsx'
import { useFirm } from '../lib/session'
import { db } from '../lib/supabase'
import type { AuditEntry, Client, Period, Row } from '../lib/types'
import { itcAtRisk, itcSafe } from './MonthPage'

interface Props {
  client: Client; period: Period; rows: Row[]; auditLog: AuditEntry[]; open: number; noRegister: boolean
  onAudit: () => Promise<void>; onBack: () => void; onChange: () => Promise<unknown>
}

const COPIED = 'Copied supplier message'

export default function CloseStep({ client, period, rows, auditLog, open, noRegister, onAudit, onBack, onChange }: Props) {
  const { firm, email } = useFirm()
  const toast = useToast()
  const [showAudit, setShowAudit] = useState(false)
  const month = periodLabel(period.period)
  const final = period.status === 'final'
  const did = (action: string, detail?: string) => auditLog.some(a => a.action === action && (!detail || a.detail === detail))
  const log = async (action: string, detail = '') => { await audit(firm.id, client.id, period.id, email, action, detail); await onAudit() }

  const groups = supplierGroups(rows)
  const allCopied = groups.every(g => did(COPIED, `${g.supplier} · ${g.gstin}`))

  async function copy(g: (typeof groups)[number]) {
    const ok = await copyText(supplierMessage(g, client.name, client.gstin, period.period))
    toast(ok ? 'Message copied. Paste it into email or WhatsApp.' : 'Copy failed: select the text and press Ctrl+C')
    if (ok) await log(COPIED, `${g.supplier} · ${g.gstin}`)
  }

  async function setStatus(status: Period['status']) {
    const { error } = await db().from('periods').update({ status }).eq('id', period.id)
    if (error) { toast(errorText(error)); return }
    await log(status === 'final' ? `Closed ${month}` : `Reopened ${month}`)
    await onChange()
    toast(status === 'final' ? `${month} closed` : `${month} reopened`)
  }

  const summary = {
    'Invoices matched': rows.filter(r => r.status === 'matched').length,
    'ITC safe to claim': itcSafe(rows), 'ITC you may lose': itcAtRisk(rows), 'Issues left': open,
  }

  const supplierStep = (
    <Check done={groups.length === 0 || allCopied} title={groups.length ? `Send ${groups.length} supplier message${groups.length > 1 ? 's' : ''}` : 'No suppliers to chase'}
      text={groups.length ? 'Copy each message and send it by email or WhatsApp.' : 'Every invoice is in GSTR-2B or sorted.'}>
      {groups.length > 0 && (
        <div className="cards" style={{ padding: 0 }}>{groups.map(g => {
          const sent = did(COPIED, `${g.supplier} · ${g.gstin}`)
          return (
            <div className="card" key={g.gstin}>
              <div className="card-top"><div><div className="s1">{g.supplier}</div><div className="mono muted">{g.gstin}</div></div>
                <span className={`pill ${sent ? 'p-good' : g.valueIssue ? 'p-warn' : 'p-bad'}`}>{sent ? 'Copied' : g.valueIssue ? 'Amount differs' : `${g.items.length} missing`}</span></div>
              <div className="small muted">ITC waiting: <b className="num" style={{ color: 'var(--ink)' }}>{inr(g.tax)}</b></div>
              <pre className="msg">{supplierMessage(g, client.name, client.gstin, period.period)}</pre>
              <div className="actions"><button className="btn sm primary" onClick={() => copy(g)}>{sent ? 'Copy again' : 'Copy message'}</button></div>
            </div>
          )
        })}</div>
      )}
    </Check>
  )

  const imsStep = (
    <Check done={did('Downloaded IMS list')} title="Download the IMS list" text="Accept, reject or pending for every invoice, ready to enter on the GST portal.">
      <button className="btn sm" onClick={async () => { exportIms(client, period, rows); await log('Downloaded IMS list') }}>Download IMS list</button>
    </Check>
  )

  return (
    <>
      <Hint id="close">Tick these off, then close the month. Closing locks the answers; you can reopen any time.</Hint>
      <section className="panel">
        <div className="panel-body">
          <div className="close-summary">
            <span><b className="num">{summary['Invoices matched']}</b> matched</span>
            <span>ITC safe <b className="num" style={{ color: 'var(--good)' }}>{inr(summary['ITC safe to claim'])}</b></span>
            <span>ITC you may lose <b className="num" style={{ color: 'var(--bad)' }}>{inr(summary['ITC you may lose'])}</b></span>
            {open > 0 && <span><b className="num" style={{ color: 'var(--warn)' }}>{open}</b> issues left · <button className="link" onClick={onBack}>Go back</button></span>}
          </div>
        </div>
      </section>

      <ol className="checklist">
        {noRegister ? (
          <>
            <Check done={did('Exported purchase register')} title="Download the purchase register" text="Every invoice the client has, in Tally column order.">
              <button className="btn sm" onClick={async () => { exportRegister(client, period, rows); await log('Exported purchase register') }}>Download register</button>
            </Check>
            {imsStep}
            {supplierStep}
          </>
        ) : (
          <>
            {supplierStep}
            {imsStep}
            <Check done={did('Exported reconciliation report')} title="Download the full report" text="Every invoice, decision and note, plus the audit trail, in one Excel file.">
              <button className="btn sm" onClick={async () => { exportReconciliation(client, period, rows, auditLog, summary); await log('Exported reconciliation report') }}>Download report</button>
            </Check>
          </>
        )}
        <Check done={final} title={final ? `${month} is closed` : `Close ${month}`}
          text={final ? 'Answers are locked. Reopen to change anything.' : open ? `${open} issue${open > 1 ? 's' : ''} left in step 2 first.` : 'Locks the answers for this month.'}>
          {final
            ? <button className="btn sm" onClick={() => setStatus('in_review')}>Reopen {month}</button>
            : open ? <button className="btn sm" onClick={onBack}>Go to step 2</button>
            : <button className="btn sm primary" onClick={() => setStatus('final')}>Close {month}</button>}
        </Check>
      </ol>

      <div>
        <button className="link small" onClick={() => setShowAudit(!showAudit)}>{showAudit ? 'Hide' : 'Show'} audit trail ({auditLog.length})</button>
        {showAudit && (
          <section className="panel" style={{ marginTop: 8 }}>
            <div className="table-wrap"><table>
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
              <tbody>{auditLog.map(a => (
                <tr key={a.id}><td className="num" style={{ whiteSpace: 'nowrap' }}>{new Date(a.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td className="small">{a.user_email}</td><td className="s1">{a.action}</td><td className="small muted">{a.detail}</td></tr>
              ))}</tbody>
            </table></div>
          </section>
        )}
      </div>
    </>
  )
}

function Check({ done, title, text, children }: { done: boolean; title: string; text: string; children?: ReactNode }) {
  return (
    <li className={`check ${done ? 'done' : ''}`}>
      <span className="tick" aria-hidden="true">{done ? '✓' : ''}</span>
      <div className="check-body">
        <div><b>{title}</b><div className="small muted">{text}</div></div>
        {children}
      </div>
    </li>
  )
}
