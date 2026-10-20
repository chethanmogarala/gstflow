import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { errorText, useToast } from '../components/ui'
import { dmy, inr, periodLabel } from '../engine/format'
import { readSheet, suppliersFromSheet } from '../engine/parse'
import { audit } from '../lib/data'
import { useFirm } from '../lib/session'
import { db } from '../lib/supabase'
import type { Client, Mode, Period } from '../lib/types'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const sortKey = (p: string) => p.slice(2) + p.slice(0, 2)

export default function ClientPage() {
  const { clientId } = useParams()
  const { firm, email, member } = useFirm()
  const toast = useToast()
  const nav = useNavigate()
  const [client, setClient] = useState<Client | null>(null)
  const [periods, setPeriods] = useState<Period[]>([])
  const [supplierCount, setSupplierCount] = useState(0)
  const today = new Date()
  const last = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const [month, setMonth] = useState(last.getMonth() + 1)
  const [year, setYear] = useState(last.getFullYear())
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function load() {
    const [{ data: c }, { data: ps }, { count }] = await Promise.all([
      db().from('clients').select('*').eq('id', clientId).single(),
      db().from('periods').select('*').eq('client_id', clientId),
      db().from('suppliers').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
    ])
    setClient(c)
    setPeriods((ps ?? []).sort((a, b) => sortKey(b.period).localeCompare(sortKey(a.period))))
    setSupplierCount(count ?? 0)
  }
  useEffect(() => { load() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!client) return <div className="empty">Loading…</div>

  async function startPeriod() {
    const period = String(month).padStart(2, '0') + year
    const existing = periods.find(p => p.period === period)
    if (existing) { nav(`/clients/${client!.id}/periods/${existing.id}`); return }
    const { data, error } = await db().from('periods').insert({ firm_id: firm.id, client_id: client!.id, period }).select().single()
    if (error) { toast(errorText(error)); return }
    await audit(firm.id, client!.id, data.id, email, 'Started return period', periodLabel(period))
    nav(`/clients/${client!.id}/periods/${data.id}`)
  }

  async function setMode(mode: Mode) {
    const { error } = await db().from('clients').update({ mode }).eq('id', client!.id)
    if (error) { toast(errorText(error)); return }
    await audit(firm.id, client!.id, null, email, 'Changed mode', mode === '2b_first' ? 'GSTR-2B first' : 'Purchase register + GSTR-2B')
    setClient({ ...client!, mode })
  }

  async function uploadSuppliers(file: File) {
    try {
      const list = suppliersFromSheet(await readSheet(file))
      if (!list.length) { toast('No rows with a valid GSTIN found in that file'); return }
      const { error } = await db().from('suppliers').upsert(
        list.map(s => ({ ...s, firm_id: firm.id, client_id: client!.id })), { onConflict: 'client_id,gstin' })
      if (error) throw error
      await audit(firm.id, client!.id, null, email, 'Uploaded supplier list', `${file.name} · ${list.length} suppliers`)
      toast(`${list.length} suppliers saved`)
      load()
    } catch (e) { toast(errorText(e)) }
  }

  async function deleteClient() {
    const { error } = await db().from('clients').delete().eq('id', client!.id)
    if (error) { toast(errorText(error)); return }
    toast('Client deleted')
    nav('/')
  }

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow"><Link to="/">Clients</Link> · <span className="mono">{client.gstin}</span></div>
          <h1>{client.name}</h1>
          <p className="sub">Start or open a return period. Unmatched invoices carry forward automatically to the next period.</p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Return periods</h2></div>
        <div className="panel-body">
          <div className="actions">
            <select className="input" style={{ width: 'auto' }} id="p-month" value={month} onChange={e => setMonth(Number(e.target.value))} aria-label="Month">
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select className="input" style={{ width: 'auto' }} id="p-year" value={year} onChange={e => setYear(Number(e.target.value))} aria-label="Year">
              {[today.getFullYear() - 1, today.getFullYear()].map(y => <option key={y}>{y}</option>)}
            </select>
            <button className="btn primary" onClick={startPeriod}>Open period</button>
          </div>
        </div>
        {periods.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Period</th><th>Status</th><th>Files</th><th className="r">Matched</th><th className="r">ITC at risk</th><th>Last run</th></tr></thead>
            <tbody>
              {periods.map(p => {
                const s = p.summary as { counts?: Record<string, number>; itcAtRisk?: number } | null
                return (
                  <tr key={p.id} className="click" onClick={() => nav(`/clients/${client.id}/periods/${p.id}`)}>
                    <td className="s1">{periodLabel(p.period)}</td>
                    <td><span className={`pill ${p.status === 'final' ? 'p-good' : p.status === 'in_review' ? 'p-info' : 'p-mute'}`}>{p.status === 'final' ? 'Final' : p.status === 'in_review' ? 'In review' : 'Files awaited'}</span></td>
                    <td className="small muted">{[p.register_file, p.b2b_file].filter(Boolean).join(' · ') || '–'}</td>
                    <td className="r num">{s?.counts?.matched ?? '–'}</td>
                    <td className="r num">{s?.itcAtRisk != null ? inr(s.itcAtRisk) : '–'}</td>
                    <td className="num">{p.run_at ? dmy(p.run_at) : '–'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>How this client's purchases come in</h2></div>
        <div className="panel-body">
          <div className="mode">
            <button className={client.mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}><b>Purchase register + GSTR-2B</b><span>Client keeps books in Tally, Busy or Excel</span></button>
            <button className={client.mode === '2b_first' ? 'on' : ''} onClick={() => setMode('2b_first')}><b>GSTR-2B first</b><span>Messy or missing books: build the register from 2B</span></button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Supplier list</h2><span className="small muted">{supplierCount} suppliers saved</span></div>
        <div className="panel-body">
          <p className="small muted" style={{ margin: 0 }}>
            Optional. Used to flag cancelled GSTINs and blocked credits. CSV or Excel with columns: <code>gstin</code>, <code>name</code>,
            <code>registration_status</code> (Active / Cancelled), <code>cancelled_on</code>, <code>category</code> (e.g. Food and catering).
            {' '}<a href={`${import.meta.env.BASE_URL}samples/supplier_master.csv`} download>Download a sample</a>
          </p>
          <input type="file" id="suppliers" accept=".csv,.xlsx,.xls" onChange={e => e.target.files?.[0] && uploadSuppliers(e.target.files[0])} />
        </div>
      </section>

      {member.role === 'admin' && (
        <section className="panel">
          <div className="panel-head"><h2>Delete client</h2></div>
          <div className="panel-body">
            <p className="small muted" style={{ margin: 0 }}>Deletes this client and all its periods, imports, decisions and audit history. This cannot be undone.</p>
            <div className="actions">
              {confirmDelete
                ? <><button className="btn danger" onClick={deleteClient}>Yes, delete {client.name}</button><button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button></>
                : <button className="btn danger" onClick={() => setConfirmDelete(true)}>Delete client</button>}
            </div>
          </div>
        </section>
      )}
    </>
  )
}
