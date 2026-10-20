import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { copyText, Drawer, errorText, STATUS, StatusPill, Tile, useToast } from '../components/ui'
import { dmy, inr } from '../engine/format'
import { invLoose, RULES } from '../engine/reconcile'
import type { ImsAction, Status } from '../engine/types'
import { audit, loadAudit, loadRows, updateResult } from '../lib/data'
import { DECISIONS, explain, isOpen, supplierGroups, supplierMessage } from '../lib/explain'
import { exportReconciliation } from '../lib/exportXlsx'
import { useFirm } from '../lib/session'
import { db } from '../lib/supabase'
import type { AuditEntry, Client, Period, Row } from '../lib/types'

interface Props { client: Client; period: Period; head: ReactNode; onReimport: () => void; onPeriodChange: () => void }
type Tab = 'recon' | 'ims' | 'risk' | 'sup' | 'audit'
type Filter = 'all' | 'open' | Status

const RISK_CLS: Record<string, string> = { RCM: 'p-info', 'Cancelled GSTIN': 'p-bad', Duplicate: 'p-warn', 'Blocked 17(5)': 'p-bad', 'Wrong tax type': 'p-warn' }

export default function Workspace({ client, period, head, onReimport, onPeriodChange }: Props) {
  const { firm, email } = useFirm()
  const toast = useToast()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([])
  const [tab, setTab] = useState<Tab>('recon')
  const [filter, setFilter] = useState<Filter>('open')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const reload = useCallback(async () => {
    const [r, a] = await Promise.all([loadRows(period.id), loadAudit(period.id)])
    setRows(r)
    setAuditLog(a)
  }, [period.id])
  useEffect(() => { reload().catch(e => toast(errorText(e))) }, [reload, toast])

  const stats = useMemo(() => {
    const list = rows ?? []
    const count = (s: Status) => list.filter(r => r.status === s).length
    const sum = (f: (r: Row) => number) => list.reduce((s, r) => s + f(r), 0)
    return {
      matched: count('matched'), probable: count('probable'), reg: count('only_in_register'), b2b: count('only_in_2b'),
      open: list.filter(isOpen).length,
      cf: list.filter(r => r.reg?.source === 'carry_forward' && r.status === 'matched').length,
      itcSafe: sum(r => (r.status === 'matched' || (r.status === 'probable' && r.decision === 'Confirmed match') ? r.b2b?.tax ?? 0 : 0)),
      itcReview: sum(r => (r.status === 'probable' && r.decision !== 'Confirmed match' ? r.b2b?.tax ?? 0 : 0)),
      itcAtRisk: sum(r => (r.status === 'only_in_register' && r.rule !== RULES.rcm ? r.reg?.tax ?? 0 : 0))
        + sum(r => (r.b2b && r.risks.some(x => x.type === 'Blocked 17(5)') ? r.b2b.tax : 0)),
    }
  }, [rows])

  async function saveOpenCount(next: Row[]) {
    const open = next.filter(isOpen).length
    await db().from('periods').update({ summary: { ...(period.summary ?? {}), open, itcAtRisk: stats.itcAtRisk } }).eq('id', period.id)
  }

  async function decide(r: Row, decision: string | null) {
    try {
      const patch = decision
        ? { decision, note: note.trim() || null, decided_by: email, decided_at: new Date().toISOString() }
        : { decision: null, note: null, decided_by: null, decided_at: null }
      await updateResult(r.id, patch)
      const label = `${r.supplier} · ${r.reg?.invoice ?? r.b2b?.invoice}`
      await audit(firm.id, client.id, period.id, email, decision ? decision : 'Reopened decision', decision ? `${label}${note.trim() ? ' · ' + note.trim() : ''}` : `${label} · was "${r.decision}"`)
      const next = rows!.map(x => (x.id === r.id ? { ...x, ...patch } : x))
      setRows(next)
      setNote('')
      await saveOpenCount(next)
      setAuditLog(await loadAudit(period.id))
      toast(decision ? 'Decision saved to the audit trail' : 'Decision reopened')
    } catch (e) { toast(errorText(e)) }
  }

  async function setIms(r: Row, value: ImsAction) {
    try {
      await updateResult(r.id, { ims_final: value })
      await audit(firm.id, client.id, period.id, email, `Set IMS action to ${value}`, `${r.supplier} · ${r.b2b?.invoice} · suggested ${r.ims_suggested ?? '–'}`)
      setRows(rows!.map(x => (x.id === r.id ? { ...x, ims_final: value } : x)))
      setAuditLog(await loadAudit(period.id))
    } catch (e) { toast(errorText(e)) }
  }

  async function setStatus(status: Period['status']) {
    const { error } = await db().from('periods').update({ status }).eq('id', period.id)
    if (error) { toast(errorText(error)); return }
    await audit(firm.id, client.id, period.id, email, status === 'final' ? 'Marked period final' : 'Reopened period')
    onPeriodChange()
  }

  async function doExport() {
    exportReconciliation(client, period, rows!, auditLog, {
      Matched: stats.matched, 'Probable match': stats.probable, 'Only in register': stats.reg, 'Only in 2B': stats.b2b,
      'Open exceptions': stats.open, 'ITC safe to claim': stats.itcSafe, 'ITC to review': stats.itcReview, 'ITC at risk': stats.itcAtRisk,
    })
    await audit(firm.id, client.id, period.id, email, 'Exported reconciliation report', `${rows!.length} rows`)
  }

  if (!rows) return <>{head}<div className="empty">Loading results…</div></>

  const open = rows.find(r => r.id === openId) ?? null
  const groups = supplierGroups(rows)
  const imsRows = rows.filter(r => r.b2b && (r.ims_final ?? r.ims_suggested))
  const riskRows = rows.flatMap(r => r.risks.map(x => ({ r, x })))
  const tabs: [Tab, string, number][] = [
    ['recon', 'Reconciliation', rows.length], ['ims', 'IMS actions', imsRows.length], ['risk', 'ITC risks', riskRows.length],
    ['sup', 'Supplier follow-up', groups.length], ['audit', 'Audit trail', auditLog.length],
  ]

  return (
    <>
      <div className="head">
        <div>{head}<h1>{client.name}</h1>
          <p className="sub">{period.register_file} matched against {period.b2b_file}. Click any row to see how it was decided.</p></div>
        <div className="actions">
          <button className="btn" onClick={onReimport} disabled={period.status === 'final'}>Re-import</button>
          {period.status === 'final'
            ? <button className="btn" onClick={() => setStatus('in_review')}>Reopen period</button>
            : <button className="btn" onClick={() => setStatus('final')} disabled={stats.open > 0} title={stats.open ? 'Resolve all open exceptions first' : ''}>Mark final</button>}
          <button className="btn primary" onClick={doExport}>Export Excel</button>
        </div>
      </div>

      <ol className="steps">
        <li className="done">1 · Import</li><li className="done">2 · Match</li>
        <li className={stats.open ? 'now' : 'done'}>3 · Review · {stats.open} open</li>
        <li className={period.status === 'final' ? 'done' : stats.open ? '' : 'now'}>4 · {period.status === 'final' ? 'Final' : 'Export'}</li>
      </ol>

      <div className="tiles">
        <Tile k="Matched" v={stats.matched} tone="good" h={stats.cf ? `${stats.cf} across periods` : 'exact matches'} />
        <Tile k="Probable" v={stats.probable} tone="warn" h={`${inr(stats.itcReview)} ITC to review`} />
        <Tile k="Only in register" v={stats.reg} tone="bad" h="not in 2B" />
        <Tile k="Only in 2B" v={stats.b2b} h="not in register" />
        <Tile k="ITC safe to claim" v={inr(stats.itcSafe)} tone="good" money h="matched or confirmed" />
        <Tile k="ITC at risk" v={inr(stats.itcAtRisk)} tone="bad" money h="missing, cancelled, duplicate or blocked" />
      </div>

      <section className="panel">
        <div className="panel-head"><div className="tabs" role="tablist">
          {tabs.map(([k, label, n]) => <button key={k} role="tab" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}<span className="count">{n}</span></button>)}
        </div></div>

        {tab === 'recon' && <ReconTab rows={rows} filter={filter} setFilter={setFilter} q={q} setQ={setQ} onOpen={id => { setOpenId(id); setNote('') }} />}

        {tab === 'ims' && (
          <>
            <div className="chips"><span className="small muted">Suggested action for every invoice in this client's IMS. Change any before exporting.</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Supplier</th><th>Invoice</th><th className="r">Tax in 2B</th><th>Action</th><th>Why</th></tr></thead>
              <tbody>{imsRows.map(r => {
                const v = (r.ims_final ?? r.ims_suggested)!
                return (
                  <tr key={r.id}>
                    <td><div className="s1">{r.supplier}</div><div className="s2 mono">{r.gstin}</div></td>
                    <td className="mono">{r.b2b!.invoice}</td><td className="r num">{inr(r.b2b!.tax)}</td>
                    <td><select className={`ims ${v}`} id={`ims-${r.id}`} value={v} aria-label={`IMS action for ${r.b2b!.invoice}`} onChange={e => setIms(r, e.target.value as ImsAction)}>
                      {['Accept', 'Reject', 'Pending'].map(o => <option key={o}>{o}</option>)}
                    </select>{r.ims_final && r.ims_final !== r.ims_suggested && <span className="tag">changed</span>}</td>
                    <td className="reason">{r.ims_why}</td>
                  </tr>
                )
              })}</tbody>
            </table></div>
          </>
        )}

        {tab === 'risk' && (riskRows.length === 0 ? <div className="empty">No ITC risks found.</div> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Flag</th><th>Supplier</th><th>Invoice</th><th className="r">Tax</th><th>What to do</th></tr></thead>
            <tbody>{riskRows.map(({ r, x }, i) => (
              <tr key={i} className="click" onClick={() => setOpenId(r.id)}>
                <td><span className={`pill ${RISK_CLS[x.type] ?? 'p-warn'}`}>{x.type}</span></td>
                <td><div className="s1">{r.supplier}</div><div className="s2 mono">{r.gstin}</div></td>
                <td className="mono">{(r.reg ?? r.b2b)!.invoice}</td><td className="r num">{inr((r.b2b ?? r.reg)!.tax)}</td>
                <td className="small" style={{ minWidth: 260 }}>{x.note}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ))}

        {tab === 'sup' && (groups.length === 0 ? <div className="empty">No suppliers to chase.</div> : (
          <div className="cards">{groups.map(g => {
            const text = supplierMessage(g, client.name, client.gstin, period.period)
            return (
              <div className="card" key={g.gstin}>
                <div className="card-top"><div><div className="s1">{g.supplier}</div><div className="mono muted">{g.gstin}</div></div>
                  <span className={`pill ${g.valueIssue ? 'p-warn' : 'p-bad'}`}>{g.valueIssue ? 'Value mismatch' : `${g.items.length} missing from 2B`}</span></div>
                <div className="small muted">{g.valueIssue ? 'Difference in tax' : 'ITC waiting on this supplier'}: <b className="num" style={{ color: 'var(--ink)' }}>{inr(g.tax)}</b></div>
                <pre className="msg">{text}</pre>
                <div className="actions"><button className="btn sm" onClick={async () => toast((await copyText(text)) ? 'Message copied' : 'Copy failed: select the text and press Ctrl+C')}>Copy message</button></div>
              </div>
            )
          })}</div>
        ))}

        {tab === 'audit' && (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>{auditLog.map(a => (
              <tr key={a.id}><td className="num" style={{ whiteSpace: 'nowrap' }}>{new Date(a.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                <td className="small">{a.user_email}</td><td className="s1">{a.action}</td><td className="small muted">{a.detail}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      {open && (
        <Drawer title={`Review ${open.supplier}`} onClose={() => setOpenId(null)}
          head={<><StatusPill status={open.status} /><h2 style={{ marginTop: 8 }}>{open.supplier}</h2><div className="mono muted">{open.gstin}</div></>}>
          <table className="compare"><thead><tr><th /><th>Purchase register</th><th>GSTR-2B</th></tr></thead>
            <tbody>
              <Cmp k="Invoice no." a={open.reg?.invoice} b={open.b2b?.invoice} />
              <Cmp k="Date" a={dmy(open.reg?.date)} b={dmy(open.b2b?.date)} />
              <Cmp k="Taxable" a={open.reg && inr(open.reg.taxable)} b={open.b2b && inr(open.b2b.taxable)} />
              <Cmp k="GST" a={open.reg && inr(open.reg.tax)} b={open.b2b && inr(open.b2b.tax)} />
              {open.reg?.source === 'carry_forward' && <tr><td className="muted" colSpan={3}>Register row carried forward from last period</td></tr>}
            </tbody>
          </table>
          {open.reg && open.b2b && <div className="small muted">Invoice number after cleanup: <span className="mono">{invLoose(open.reg.invoice)}</span> · <span className="mono">{invLoose(open.b2b.invoice)}</span></div>}
          <div>
            <h2 style={{ fontSize: 13, marginBottom: 8 }}>How GSTFlow decided</h2>
            <ol className="rulelist">{explain(open).map(s => (
              <li key={s.name} className={s.ok === true ? 'yes' : s.ok === false ? 'no' : 'skip'}>
                <span className="mk">{s.ok === true ? '✓' : s.ok === false ? '✗' : '·'}</span><div><b>{s.name}</b><span>{s.text}</span></div>
              </li>
            ))}</ol>
          </div>
          {open.risks.map(x => <div key={x.type} className="why"><b>{x.type}:</b> {x.note}.</div>)}
          {open.decision ? (
            <div className="decided">Decision: <b>{open.decision}</b>
              {open.note && <div className="muted" style={{ marginTop: 4 }}>{open.note}</div>}
              <div className="small muted" style={{ marginTop: 4 }}>{open.decided_by} · {open.decided_at && new Date(open.decided_at).toLocaleString('en-IN')}</div>
              {period.status !== 'final' && <div style={{ marginTop: 8 }}><button className="btn sm" onClick={() => decide(open, null)}>Change decision</button></div>}
            </div>
          ) : DECISIONS[open.status].length > 0 && period.status !== 'final' ? (
            <>
              <label className="field">Note for the audit trail<textarea id={`note-${open.id}`} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Confirmed with client on phone" /></label>
              <div className="actions">{DECISIONS[open.status].map((d, i) => <button key={d} className={`btn ${i === 0 ? 'primary' : ''}`} onClick={() => decide(open, d)}>{d}</button>)}</div>
            </>
          ) : open.status === 'matched' ? <div className="small muted">No action needed. This invoice is safe to claim.</div> : null}
        </Drawer>
      )}
    </>
  )
}

function Cmp({ k, a, b }: { k: string; a?: string | null | false; b?: string | null | false }) {
  return <tr><td className="muted">{k}</td><td className="mono">{a || '—'}</td><td className={`mono ${a && b && a !== b ? 'diff' : ''}`}>{b || '—'}</td></tr>
}

function ReconTab({ rows, filter, setFilter, q, setQ, onOpen }: {
  rows: Row[]; filter: Filter; setFilter: (f: Filter) => void; q: string; setQ: (s: string) => void; onOpen: (id: string) => void
}) {
  const by = (k: string) => rows.filter(r => r.rule === k).length
  const left = (s: Status) => rows.filter(r => r.status === s && r.rule === RULES.none).length
  const regIn = rows.filter(r => r.reg && r.reg.source === 'register').length
  const cfIn = rows.filter(r => r.reg?.source === 'carry_forward').length
  const b2bIn = rows.filter(r => r.b2b).length
  const needle = q.trim().toLowerCase()
  const list = rows
    .filter(r => filter === 'all' || (filter === 'open' ? isOpen(r) : r.status === filter))
    .filter(r => !needle || [r.supplier, r.gstin, r.reg?.invoice, r.b2b?.invoice].some(v => v?.toLowerCase().includes(needle)))
  const chips: [Filter, string][] = [['open', 'Open exceptions'], ['all', 'All'], ['matched', 'Matched'], ['probable', 'Probable'], ['only_in_register', 'Only in register'], ['only_in_2b', 'Only in 2B']]
  return (
    <>
      <div className="runline">
        <span className="lead">How matching ran:</span>
        <span className="stage"><b>{regIn}</b> register rows + <b>{cfIn}</b> carried forward · <b>{b2bIn}</b> in 2B</span><span className="arrow">→</span>
        <span className="stage">Set aside: <b>{by(RULES.duplicate)}</b> duplicate, <b>{by(RULES.rcm)}</b> reverse charge</span><span className="arrow">→</span>
        <span className="stage">Rule 1 exact <b>{by(RULES.exact)}</b></span><span className="arrow">→</span>
        <span className="stage">Rule 2 number format <b>{by(RULES.format)}</b></span><span className="arrow">→</span>
        <span className="stage">Rule 3 value difference <b>{by(RULES.value)}</b></span><span className="arrow">→</span>
        <span className="stage">Rule 4 same amounts <b>{by(RULES.sameAmounts)}</b></span><span className="arrow">→</span>
        <span className="stage">Left over: <b>{left('only_in_register')}</b> register, <b>{left('only_in_2b')}</b> 2B</span>
      </div>
      <div className="chips">
        {chips.map(([k, label]) => <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label}</button>)}
        <input className="search" id="search" type="search" placeholder="Search supplier, GSTIN or invoice" value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Supplier</th><th>Invoice (register · 2B)</th><th>Date</th><th className="r">Taxable</th><th className="r">Tax</th><th>Status</th><th>Reason</th></tr></thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={7} className="empty">{filter === 'open' ? 'No open exceptions. Everything is reviewed.' : 'Nothing here.'}</td></tr>}
          {list.map(r => (
            <tr key={r.id} className="click" onClick={() => onOpen(r.id)}>
              <td><div className="s1">{r.supplier}</div><div className="s2 mono">{r.gstin}</div></td>
              <td className="mono">{r.reg?.invoice ?? '—'} · {r.b2b?.invoice ?? '—'}</td>
              <td className="num">{dmy((r.reg ?? r.b2b)?.date)}</td>
              <td className="r num">{r.reg ? inr(r.reg.taxable) : ''}{r.b2b && (!r.reg || r.b2b.taxable !== r.reg.taxable) && <div className={r.reg ? 'diff' : ''}>{inr(r.b2b.taxable)}{r.reg ? ' (2B)' : ''}</div>}</td>
              <td className="r num">{r.reg ? inr(r.reg.tax) : ''}{r.b2b && (!r.reg || r.b2b.tax !== r.reg.tax) && <div className={r.reg ? 'diff' : ''}>{inr(r.b2b.tax)}{r.reg ? ' (2B)' : ''}</div>}</td>
              <td><span className={`pill ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>{r.reg?.source === 'carry_forward' && <span className="tag">prev. period</span>}
                {r.decision && <div className="s2" style={{ marginTop: 4 }}>✓ {r.decision}</div>}</td>
              <td className="reason">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </>
  )
}
