import { useState, type FormEvent } from 'react'
import { errorText, Hint, useToast } from '../components/ui'
import { dmy, inr } from '../engine/format'
import { GSTIN_RE, RULES } from '../engine/reconcile'
import type { ImsAction } from '../engine/types'
import { addManualInvoice, audit, loadRows, saveProgress, updateResult } from '../lib/data'
import { explain } from '../lib/explain'
import { useFirm } from '../lib/session'
import { GROUP_ORDER, GROUPS, groupOf, needsAction, openCount, optionsFor, type GroupKey, type Option } from '../lib/todo'
import type { Client, Mark, Period, Row } from '../lib/types'
import { itcAtRisk, itcSafe } from './MonthPage'

interface Props {
  client: Client; period: Period; rows: Row[]; setRows: (r: Row[]) => void
  final: boolean; noRegister: boolean; onAudit: () => void; onNext: () => void
}

const MARKS: [Mark, string, ImsAction, string][] = [
  ['have', 'Client has it', 'Accept', 'Accepts it in IMS'],
  ['ask', 'Ask client', 'Pending', 'Keeps it pending in IMS'],
  ['not', 'Not ours', 'Reject', 'Rejects it in IMS'],
]
const label = (r: Row) => `${r.supplier} · ${r.reg?.invoice ?? r.b2b?.invoice}`

export default function FixStep({ client, period, rows, setRows, final, noRegister, onAudit, onNext }: Props) {
  const { firm, email } = useFirm()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [showMatched, setShowMatched] = useState(false)
  const open = openCount(rows)

  async function apply(changes: { r: Row; patch: Partial<Row>; action: string; detail: string }[]) {
    try {
      for (const c of changes) await updateResult(c.r.id, c.patch)
      for (const c of changes) await audit(firm.id, client.id, period.id, email, c.action, c.detail)
      const byId = new Map(changes.map(c => [c.r.id, c.patch]))
      const next = rows.map(x => (byId.has(x.id) ? { ...x, ...byId.get(x.id) } : x))
      setRows(next)
      await saveProgress(period, next, itcAtRisk(next))
      onAudit()
      return next
    } catch (e) { toast(errorText(e)); return null }
  }

  async function decide(r: Row, opt: Option | null, note = '') {
    const patch: Partial<Row> = opt
      ? { decision: opt.decision, ims_final: opt.ims ?? r.ims_final, note: note.trim() || null, decided_by: email, decided_at: new Date().toISOString() }
      : { decision: null, ims_final: null, note: null, decided_by: null, decided_at: null }
    const next = await apply([{ r, patch, action: opt ? opt.decision : 'Undid decision', detail: opt ? `${label(r)}${note.trim() ? ' · ' + note.trim() : ''}` : `${label(r)} · was "${r.decision}"` }])
    if (next && opt && openCount(next) === 0) toast('All issues sorted. Go to step 3 to send and close.')
  }

  async function mark(r: Row, m: Mark | null) {
    const ims = m ? MARKS.find(x => x[0] === m)![2] : null
    await apply([{ r, patch: { mark: m, ims_final: ims, decided_by: email, decided_at: new Date().toISOString() },
      action: m ? MARKS.find(x => x[0] === m)![1] : 'Cleared answer', detail: label(r) }])
  }

  const needle = q.trim().toLowerCase()
  const visible = rows.filter(r => !needle || [r.supplier, r.gstin, r.reg?.invoice, r.b2b?.invoice].some(v => v?.toLowerCase().includes(needle)))
  const matched = rows.filter(r => r.status === 'matched' && !groupOf(r))

  return (
    <>
      {!noRegister && <Hint id="fix">Work down the list. Each button saves straight away and sets the IMS action for you.</Hint>}
      {final && <div className="notice">This month is closed, so answers are read-only. Reopen it in step 3 to change them.</div>}

      <div className="fix-bar">
        {!noRegister && (
          <span className="small">
            <b style={{ color: 'var(--good)' }}>✓ {matched.length} matched</b> · {inr(itcSafe(rows))} ITC safe ·{' '}
            <button className="link" onClick={() => setShowMatched(!showMatched)}>{showMatched ? 'Hide' : 'View'}</button>
          </span>
        )}
        <span className="small"><b>{open}</b> {open === 1 ? 'issue' : 'issues'} left</span>
        <input className="search" id="search" type="search" placeholder="Find supplier, GSTIN or invoice" value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
      </div>

      {showMatched && (
        <section className="panel">
          <div className="panel-head"><h2>Matched</h2><span className="small muted">Nothing to do. These are safe to claim.</span></div>
          <div className="table-wrap"><table>
            <thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th><th className="r">Taxable</th><th className="r">GST</th></tr></thead>
            <tbody>{matched.map(r => (
              <tr key={r.id}><td><div className="s1">{r.supplier}</div><div className="s2 mono">{r.gstin}</div></td>
                <td className="mono">{r.b2b?.invoice}{r.reg?.source === 'carry_forward' && <span className="tag">from last month</span>}</td>
                <td className="num">{dmy(r.b2b?.date)}</td><td className="r num">{inr(r.b2b?.taxable ?? 0)}</td><td className="r num">{inr(r.b2b?.tax ?? 0)}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      {open === 0 && !final && (
        <div className="notice good row-between">
          <span>All issues are sorted.</span>
          <button className="btn primary" onClick={onNext}>Go to step 3: Send & close →</button>
        </div>
      )}

      {GROUP_ORDER.map(g => {
        const items = visible.filter(r => groupOf(r) === g)
        if (!items.length) return null
        return g === 'confirm2b'
          ? <ConfirmGroup key={g} items={items} final={final} onMark={mark} />
          : <Group key={g} g={g} items={items} final={final} onDecide={decide}
              onBulk={g === 'check' ? async list => {
                const opt = optionsFor(list[0])[0]
                await apply(list.map(r => ({ r, patch: { decision: opt.decision, ims_final: opt.ims, decided_by: email, decided_at: new Date().toISOString() }, action: opt.decision, detail: `${label(r)} · bulk` })))
              } : undefined} />
      })}

      {noRegister && !final && <AddInvoice client={client} period={period} rows={rows} onAdded={async () => { setRows(await loadRows(period.id)); onAudit() }} />}
    </>
  )
}

function Group({ g, items, final, onDecide, onBulk }: {
  g: Exclude<GroupKey, 'confirm2b'>; items: Row[]; final: boolean
  onDecide: (r: Row, o: Option | null, note?: string) => void; onBulk?: (rows: Row[]) => Promise<void>
}) {
  const [showDone, setShowDone] = useState(false)
  const todo = items.filter(needsAction)
  const done = items.filter(r => !needsAction(r))
  const formatOnly = todo.filter(r => r.rule === RULES.format)
  return (
    <section className="panel todo-group">
      <div className="panel-head">
        <div><h2>{GROUPS[g].title}</h2><div className="small muted">{GROUPS[g].intro}</div>
          {g !== 'fix' && todo[0] && !final && <div className="item-help small muted">{optionsFor(todo[0]).map(o => <span key={o.label}><b>{o.label}:</b> {o.help}</span>)}</div>}</div>
        <span className={`pill ${todo.length ? 'p-warn' : 'p-good'}`}>{todo.length ? `${todo.length} left` : 'Done'}</span>
      </div>
      {onBulk && formatOnly.length > 1 && !final && (
        <div className="chips"><span className="small muted">{formatOnly.length} differ only in how the invoice number is written.</span>
          <button className="btn sm" onClick={() => onBulk(formatOnly)}>Mark all {formatOnly.length} as same invoice</button></div>
      )}
      {todo.map(r => <Item key={r.id} r={r} final={final} onDecide={onDecide} showHelp={g === 'fix'} />)}
      {done.length > 0 && (
        <div className="done-list">
          <button className="link" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} {done.length} done</button>
          {showDone && done.map(r => (
            <div key={r.id} className="done-row">
              <span><b>{r.supplier}</b> <span className="mono muted">{r.reg?.invoice ?? r.b2b?.invoice}</span></span>
              <span className="small">✓ {r.decision}{r.note && <span className="muted"> · {r.note}</span>}</span>
              {!final && <button className="link" onClick={() => onDecide(r, null)}>Undo</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function Item({ r, final, onDecide, showHelp }: { r: Row; final: boolean; onDecide: (r: Row, o: Option | null, note?: string) => void; showHelp: boolean }) {
  const [why, setWhy] = useState(false)
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState('')
  const d = r.reg ?? r.b2b!
  const both = r.reg && r.b2b
  const differs = (a?: number, b?: number) => both && a !== b
  return (
    <div className="item">
      <div className="item-main">
        <div className="item-who"><div className="s1">{r.supplier}</div><div className="s2 mono">{r.gstin}</div></div>
        <div className="item-inv">
          <div className="mono">{both && r.reg!.invoice !== r.b2b!.invoice ? <>{r.reg!.invoice} <span className="muted">vs</span> <span className="diff">{r.b2b!.invoice}</span></> : d.invoice}</div>
          <div className="s2">{dmy(d.date)}{r.reg?.source === 'carry_forward' && <span className="tag">from last month</span>}</div>
        </div>
        <div className="item-amt num">
          <div>Taxable {inr(d.taxable)}{differs(r.reg?.taxable, r.b2b?.taxable) && <span className="diff"> · 2B {inr(r.b2b!.taxable)}</span>}</div>
          <div className="muted">GST {inr(d.tax)}{differs(r.reg?.tax, r.b2b?.tax) && <span className="diff"> · 2B {inr(r.b2b!.tax)}</span>}</div>
        </div>
      </div>
      <div className="item-reason">
        {r.risks.length ? r.risks.map(x => <div key={x.type}><b>{x.type}:</b> {x.note}.</div>) : `${r.reason}. `}
        <button className="link" onClick={() => setWhy(!why)}>{why ? 'Hide' : 'Why?'}</button>
      </div>
      {why && (
        <ol className="rulelist">{explain(r).map(s => (
          <li key={s.name} className={s.ok === true ? 'yes' : s.ok === false ? 'no' : 'skip'}>
            <span className="mk">{s.ok === true ? '✓' : s.ok === false ? '✗' : '·'}</span><div><b>{s.name}</b><span>{s.text}</span></div>
          </li>
        ))}</ol>
      )}
      {!final && (
        <>
          {noting && <textarea className="input" id={`note-${r.id}`} value={note} onChange={e => setNote(e.target.value)} placeholder="Note for the audit trail, e.g. confirmed with client on phone" />}
          <div className="item-actions">
            {optionsFor(r).map((o, i) => (
              <button key={o.label} className={`btn sm ${i === 0 ? 'primary' : ''}`} onClick={() => onDecide(r, o, note)}>{o.label}</button>
            ))}
            {!noting && <button className="link small" onClick={() => setNoting(true)}>Add note</button>}
          </div>
          {showHelp && <div className="item-help small muted">{optionsFor(r).map(o => <span key={o.label}>{o.help}</span>)}</div>}
        </>
      )}
    </div>
  )
}

function ConfirmGroup({ items, final, onMark }: { items: Row[]; final: boolean; onMark: (r: Row, m: Mark | null) => void }) {
  const n = (m: Mark | null) => items.filter(r => r.mark === m).length
  const pct = (m: Mark) => `${(n(m) / items.length) * 100}%`
  return (
    <section className="panel todo-group">
      <div className="panel-head">
        <div><h2>{GROUPS.confirm2b.title}</h2><div className="small muted">{GROUPS.confirm2b.intro}</div></div>
        <span className={`pill ${n(null) ? 'p-warn' : 'p-good'}`}>{n(null) ? `${n(null)} left` : 'Done'}</span>
      </div>
      <div className="panel-body">
        <div className="progress" aria-label="Progress"><i style={{ width: pct('have'), background: 'var(--good)' }} /><i style={{ width: pct('ask'), background: 'var(--warn)' }} /><i style={{ width: pct('not'), background: 'var(--bad)' }} /></div>
        <div className="small muted">{MARKS.map(([, l, , h]) => <span key={l} style={{ marginRight: 14 }}><b>{l}:</b> {h}</span>)}</div>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th><th className="r">GST</th><th>Client's answer</th></tr></thead>
        <tbody>{items.map(r => (
          <tr key={r.id}>
            <td><div className="s1">{r.supplier}</div><div className="s2 mono">{r.gstin}</div></td>
            <td className="mono">{r.b2b!.invoice}</td><td className="num">{dmy(r.b2b!.date)}</td><td className="r num">{inr(r.b2b!.tax)}</td>
            <td><div className="marks">{MARKS.map(([m, l]) => (
              <button key={m} disabled={final} className={`${m} ${r.mark === m ? 'on' : ''}`} onClick={() => onMark(r, r.mark === m ? null : m)}>{l}</button>
            ))}</div></td>
          </tr>
        ))}</tbody>
      </table></div>
    </section>
  )
}

const EMPTY = { supplier: '', gstin: '', invoice: '', date: '', taxable: '', igst: '', cgst: '', sgst: '' }

function AddInvoice({ client, period, rows, onAdded }: { client: Client; period: Period; rows: Row[]; onAdded: () => void }) {
  const { email } = useFirm()
  const toast = useToast()
  const [openForm, setOpenForm] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')
  const added = rows.filter(r => r.rule === 'Added by staff')
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })

  async function add(e: FormEvent) {
    e.preventDefault()
    setError('')
    const gstin = form.gstin.trim().toUpperCase()
    if (!GSTIN_RE.test(gstin)) { setError('Supplier GSTIN is not in a valid format.'); return }
    const igst = Number(form.igst) || 0, cgst = Number(form.cgst) || 0, sgst = Number(form.sgst) || 0
    try {
      await addManualInvoice(client, period, email, {
        supplier: form.supplier.trim(), gstin, invoice: form.invoice.trim(), date: form.date || null,
        taxable: Number(form.taxable) || 0, igst, cgst, sgst, tax: igst + cgst + sgst, rcm: false, ledger: '',
      })
      setForm(EMPTY)
      toast('Added. The supplier will be in the messages in step 3.')
      onAdded()
    } catch (err) { setError(errorText(err)) }
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div><h2>Invoices the client has that are not in 2B</h2><div className="small muted">Their suppliers haven't reported them yet, so they get a message in step 3.</div></div>
        {!openForm && <button className="btn sm" onClick={() => setOpenForm(true)}>+ Add invoice</button>}
      </div>
      {added.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th><th className="r">GST</th></tr></thead>
          <tbody>{added.map(r => (
            <tr key={r.id}><td><div className="s1">{r.supplier}</div><div className="s2 mono">{r.gstin}</div></td>
              <td className="mono">{r.reg!.invoice}</td><td className="num">{dmy(r.reg!.date)}</td><td className="r num">{inr(r.reg!.tax)}</td></tr>
          ))}</tbody>
        </table></div>
      )}
      {openForm && (
        <form className="panel-body" onSubmit={add}>
          <div className="form-row">
            <label className="field">Supplier<input id="a-sup" required value={form.supplier} onChange={set('supplier')} /></label>
            <label className="field">GSTIN<input id="a-gstin" required maxLength={15} className="mono" value={form.gstin} onChange={set('gstin')} /></label>
            <label className="field">Invoice no.<input id="a-no" required value={form.invoice} onChange={set('invoice')} /></label>
            <label className="field">Date<input id="a-date" type="date" required value={form.date} onChange={set('date')} /></label>
          </div>
          <div className="form-row">
            <label className="field">Taxable ₹<input id="a-tx" type="number" min="0" step="0.01" required value={form.taxable} onChange={set('taxable')} /></label>
            <label className="field">IGST ₹<input id="a-igst" type="number" min="0" step="0.01" value={form.igst} onChange={set('igst')} /></label>
            <label className="field">CGST ₹<input id="a-cgst" type="number" min="0" step="0.01" value={form.cgst} onChange={set('cgst')} /></label>
            <label className="field">SGST ₹<input id="a-sgst" type="number" min="0" step="0.01" value={form.sgst} onChange={set('sgst')} /></label>
          </div>
          {error && <div className="notice bad">{error}</div>}
          <div className="actions"><button className="btn primary">Add invoice</button><button type="button" className="btn" onClick={() => setOpenForm(false)}>Cancel</button></div>
        </form>
      )}
    </section>
  )
}
