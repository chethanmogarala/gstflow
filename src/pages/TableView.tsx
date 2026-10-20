// Every invoice in one table, with filters; click a row to review and decide in a side panel.
import { useState } from 'react'
import { Drawer, STATUS, StatusPill } from '../components/ui'
import { dmy, inr } from '../engine/format'
import { invLoose, RULES } from '../engine/reconcile'
import type { Status } from '../engine/types'
import { explain } from '../lib/explain'
import { needsAction, optionsFor, type Option } from '../lib/todo'
import type { Row } from '../lib/types'

type Filter = 'todo' | 'all' | Status

const CHIPS: [Filter, string][] = [
  ['todo', 'Needs a decision'], ['all', 'All'], ['matched', 'Matched'], ['probable', 'Small difference'],
  ['only_in_register', 'Missing from 2B'], ['only_in_2b', "Not in client's books"],
]

interface Props { rows: Row[]; final: boolean; onDecide: (r: Row, o: Option | null, note?: string) => void }

export default function TableView({ rows, final, onDecide }: Props) {
  const [filter, setFilter] = useState<Filter>('todo')
  const [openId, setOpenId] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const count = (f: Filter) => rows.filter(r => match(r, f)).length
  const list = rows.filter(r => match(r, filter))
  const open = rows.find(r => r.id === openId) ?? null
  const by = (k: string) => rows.filter(r => r.rule === k).length
  const left = (s: Status) => rows.filter(r => r.status === s && r.rule === RULES.none).length

  return (
    <section className="panel">
      <div className="runline">
        <span className="lead">How matching ran:</span>
        <span className="stage"><b>{rows.filter(r => r.reg?.source === 'register').length}</b> register rows + <b>{rows.filter(r => r.reg?.source === 'carry_forward').length}</b> from last month · <b>{rows.filter(r => r.b2b).length}</b> in 2B</span><span className="arrow">→</span>
        <span className="stage">Set aside: <b>{by(RULES.duplicate)}</b> duplicate, <b>{by(RULES.rcm)}</b> reverse charge</span><span className="arrow">→</span>
        <span className="stage">Exact <b>{by(RULES.exact)}</b></span><span className="arrow">→</span>
        <span className="stage">Number format <b>{by(RULES.format)}</b></span><span className="arrow">→</span>
        <span className="stage">Value difference <b>{by(RULES.value)}</b></span><span className="arrow">→</span>
        <span className="stage">Same amounts <b>{by(RULES.sameAmounts)}</b></span><span className="arrow">→</span>
        <span className="stage">Left over: <b>{left('only_in_register')}</b> register, <b>{left('only_in_2b')}</b> 2B</span>
      </div>
      <div className="chips">
        {CHIPS.map(([k, label]) => (
          <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label} <span className="count">{count(k)}</span></button>
        ))}
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Supplier</th><th>Invoice (register · 2B)</th><th>Date</th><th className="r">Taxable</th><th className="r">GST</th><th>Status</th><th>Reason</th></tr></thead>
        <tbody>
          {list.length === 0 && <tr><td colSpan={7} className="empty">{filter === 'todo' ? 'Nothing needs a decision. Everything is sorted.' : 'Nothing here.'}</td></tr>}
          {list.map(r => (
            <tr key={r.id} className="click" onClick={() => { setOpenId(r.id); setNote('') }}>
              <td><div className="s1">{r.supplier}</div><div className="s2 mono">{r.gstin}</div></td>
              <td className="mono">{r.reg?.invoice ?? '—'} · {r.b2b?.invoice ?? '—'}</td>
              <td className="num">{dmy((r.reg ?? r.b2b)?.date)}</td>
              <td className="r num">{r.reg ? inr(r.reg.taxable) : ''}{r.b2b && (!r.reg || r.b2b.taxable !== r.reg.taxable) && <div className={r.reg ? 'diff' : ''}>{inr(r.b2b.taxable)}{r.reg ? ' (2B)' : ''}</div>}</td>
              <td className="r num">{r.reg ? inr(r.reg.tax) : ''}{r.b2b && (!r.reg || r.b2b.tax !== r.reg.tax) && <div className={r.reg ? 'diff' : ''}>{inr(r.b2b.tax)}{r.reg ? ' (2B)' : ''}</div>}</td>
              <td>
                <span className={`pill ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                {r.reg?.source === 'carry_forward' && <span className="tag">from last month</span>}
                {r.risks.map(x => <div key={x.type} className="s2" style={{ marginTop: 4, color: 'var(--bad)' }}>{x.type}</div>)}
                {r.decision ? <div className="s2" style={{ marginTop: 4 }}>✓ {r.decision}</div> : needsAction(r) && <div className="s2" style={{ marginTop: 4, color: 'var(--warn)' }}>Needs a decision</div>}
              </td>
              <td className="reason">{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table></div>

      {open && (
        <Drawer title={`Review ${open.supplier}`} onClose={() => setOpenId(null)}
          head={<><StatusPill status={open.status} /><h2 style={{ marginTop: 8 }}>{open.supplier}</h2><div className="mono muted">{open.gstin}</div></>}>
          <table className="compare"><thead><tr><th /><th>Purchase register</th><th>GSTR-2B</th></tr></thead>
            <tbody>
              <Cmp k="Invoice no." a={open.reg?.invoice} b={open.b2b?.invoice} />
              <Cmp k="Date" a={dmy(open.reg?.date)} b={dmy(open.b2b?.date)} />
              <Cmp k="Taxable" a={open.reg && inr(open.reg.taxable)} b={open.b2b && inr(open.b2b.taxable)} />
              <Cmp k="GST" a={open.reg && inr(open.reg.tax)} b={open.b2b && inr(open.b2b.tax)} />
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
              <div className="small muted" style={{ marginTop: 4 }}>{open.decided_by}{open.decided_at && ` · ${new Date(open.decided_at).toLocaleString('en-IN')}`}</div>
              {!final && <div style={{ marginTop: 8 }}><button className="btn sm" onClick={() => onDecide(open, null)}>Undo</button></div>}
            </div>
          ) : optionsFor(open).length > 0 && !final ? (
            <>
              <label className="field">Note for the audit trail<textarea id={`tnote-${open.id}`} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Confirmed with client on phone" /></label>
              <div className="actions">{optionsFor(open).map((o, i) => <button key={o.label} className={`btn ${i === 0 ? 'primary' : ''}`} onClick={() => { onDecide(open, o, note); setNote('') }}>{o.label}</button>)}</div>
              <div className="item-help small muted">{optionsFor(open).map(o => <span key={o.label}><b>{o.label}:</b> {o.help}</span>)}</div>
            </>
          ) : open.status === 'matched' ? <div className="small muted">No action needed. This invoice is safe to claim.</div> : null}
        </Drawer>
      )}
    </section>
  )
}

function match(r: Row, f: Filter) {
  if (f === 'all') return true
  if (f === 'todo') return needsAction(r)
  return r.status === f
}

function Cmp({ k, a, b }: { k: string; a?: string | null | false; b?: string | null | false }) {
  return <tr><td className="muted">{k}</td><td className="mono">{a || '—'}</td><td className={`mono ${a && b && a !== b ? 'diff' : ''}`}>{b || '—'}</td></tr>
}
