import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { errorText, useToast } from '../components/ui'
import { dmy, inr } from '../engine/format'
import { GSTIN_RE } from '../engine/reconcile'
import type { ImsAction } from '../engine/types'
import { addManualInvoice, audit, loadRows, updateResult } from '../lib/data'
import { exportRegister } from '../lib/exportXlsx'
import { useFirm } from '../lib/session'
import type { Client, Mark, Period, Row } from '../lib/types'

interface Props { client: Client; period: Period; head: ReactNode; onReimport: () => void }

const MARKS: [Mark, string, ImsAction][] = [['have', 'Has it', 'Accept'], ['ask', 'Ask client', 'Pending'], ['not', 'Not ours', 'Reject']]
const EMPTY = { supplier: '', gstin: '', invoice: '', date: '', taxable: '', igst: '', cgst: '', sgst: '' }

export default function TwoBFirst({ client, period, head, onReimport }: Props) {
  const { firm, email } = useFirm()
  const toast = useToast()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [error, setError] = useState('')

  const reload = useCallback(async () => setRows(await loadRows(period.id)), [period.id])
  useEffect(() => { reload().catch(e => toast(errorText(e))) }, [reload, toast])

  if (!rows) return <>{head}<div className="empty">Loading…</div></>

  const from2b = rows.filter(r => r.b2b)
  const manual = rows.filter(r => !r.b2b)
  const n = (m: Mark | null) => from2b.filter(r => r.mark === m).length
  const pct = (m: Mark) => `${(n(m) / Math.max(1, from2b.length)) * 100}%`
  const confirmed = rows.filter(r => r.mark === 'have').reduce((s, r) => s + (r.b2b ?? r.reg)!.tax, 0)

  async function mark(r: Row, m: Mark) {
    const next = r.mark === m ? null : m
    const ims = next ? MARKS.find(x => x[0] === next)![2] : null
    try {
      await updateResult(r.id, { mark: next, ims_final: ims, decided_by: email, decided_at: new Date().toISOString() })
      await audit(firm.id, client.id, period.id, email, next ? `Marked "${MARKS.find(x => x[0] === next)![1]}"` : 'Cleared mark', `${r.supplier} · ${r.b2b?.invoice}`)
      setRows(rows!.map(x => (x.id === r.id ? { ...x, mark: next, ims_final: ims } : x)))
    } catch (e) { toast(errorText(e)) }
  }

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
      toast('Invoice added. It will appear in supplier follow-ups.')
      reload()
    } catch (err) { setError(errorText(err)) }
  }

  async function doExport() {
    exportRegister(client, period, rows!)
    await audit(firm.id, client.id, period.id, email, 'Exported purchase register', `${rows!.filter(r => r.mark === 'have').length} invoices`)
  }

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })

  return (
    <>
      <div className="head">
        <div>{head}<h1>{client.name}</h1>
          <p className="sub">Go through each GSTR-2B invoice with the client's papers in hand, then add any invoices they have that are missing from 2B.</p></div>
        <div className="actions"><button className="btn" onClick={onReimport}>Re-import 2B</button><button className="btn primary" onClick={doExport}>Export purchase register</button></div>
      </div>

      <ol className="steps">
        <li className="done">1 · Import 2B</li>
        <li className={n(null) ? 'now' : 'done'}>2 · Confirm invoices · {from2b.length - n(null)} of {from2b.length}</li>
        <li className={n(null) ? '' : 'now'}>3 · Export register and IMS list</li>
      </ol>

      <section className="panel"><div className="panel-body">
        <div className="progress" aria-label="Progress"><i style={{ width: pct('have'), background: 'var(--good)' }} /><i style={{ width: pct('ask'), background: 'var(--warn)' }} /><i style={{ width: pct('not'), background: 'var(--bad)' }} /></div>
        <div className="small muted" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <span><b style={{ color: 'var(--good)' }}>{n('have')}</b> client has it</span><span><b style={{ color: 'var(--warn)' }}>{n('ask')}</b> ask client</span>
          <span><b style={{ color: 'var(--bad)' }}>{n('not')}</b> not ours</span><span><b style={{ color: 'var(--ink)' }}>{n(null)}</b> to check</span>
          <span>ITC confirmed: <b className="num" style={{ color: 'var(--ink)' }}>{inr(confirmed)}</b></span>
        </div>
      </div></section>

      <section className="panel">
        <div className="panel-head"><h2>GSTR-2B invoices</h2><span className="small muted">Has it → IMS Accept · Ask client → Pending · Not ours → Reject</span></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th><th className="r">Taxable</th><th className="r">Tax</th><th>Client's invoice</th></tr></thead>
          <tbody>
            {from2b.map(r => (
              <tr key={r.id}>
                <td><div className="s1">{r.supplier}</div><div className="s2 mono">{r.gstin}</div></td>
                <td className="mono">{r.b2b!.invoice}</td><td className="num">{dmy(r.b2b!.date)}</td>
                <td className="r num">{inr(r.b2b!.taxable)}</td><td className="r num">{inr(r.b2b!.tax)}</td>
                <td><div className="marks">{MARKS.map(([m, label]) => <button key={m} className={`${m} ${r.mark === m ? 'on' : ''}`} onClick={() => mark(r, m)}>{label}</button>)}</div></td>
              </tr>
            ))}
            {manual.map(r => (
              <tr key={r.id}>
                <td><div className="s1">{r.supplier}<span className="tag">added by staff</span></div><div className="s2 mono">{r.gstin}</div></td>
                <td className="mono">{r.reg!.invoice}</td><td className="num">{dmy(r.reg!.date)}</td>
                <td className="r num">{inr(r.reg!.taxable)}</td><td className="r num">{inr(r.reg!.tax)}</td>
                <td><span className="pill p-warn">Not in 2B: chase supplier</span></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <form className="panel-body" onSubmit={add} style={{ borderTop: '1px solid var(--line)' }}>
          <h2 style={{ fontSize: 13 }}>Add an invoice the client has that is not in 2B</h2>
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
          <div className="actions"><button className="btn">Add invoice</button></div>
        </form>
      </section>
    </>
  )
}
