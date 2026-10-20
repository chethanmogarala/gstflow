import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { errorText, useToast } from '../components/ui'
import { currentReturnPeriod, dmy, inr, periodLabel, periodSortKey } from '../engine/format'
import { readSheet, suppliersFromSheet } from '../engine/parse'
import { audit } from '../lib/data'
import { useFirm } from '../lib/session'
import { db } from '../lib/supabase'
import type { Client, Period } from '../lib/types'

export default function ClientSettings() {
  const { clientId } = useParams()
  const { firm, email, member } = useFirm()
  const toast = useToast()
  const nav = useNavigate()
  const [client, setClient] = useState<Client | null>(null)
  const [periods, setPeriods] = useState<Period[]>([])
  const [supplierCount, setSupplierCount] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function load() {
    const [{ data: c }, { data: ps }, { count }] = await Promise.all([
      db().from('clients').select('*').eq('id', clientId).single(),
      db().from('periods').select('*').eq('client_id', clientId),
      db().from('suppliers').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
    ])
    setClient(c)
    setPeriods((ps ?? []).sort((a: Period, b: Period) => periodSortKey(b.period).localeCompare(periodSortKey(a.period))))
    setSupplierCount(count ?? 0)
  }
  useEffect(() => { load() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!client) return <div className="empty">Loading…</div>

  async function uploadSuppliers(file: File) {
    try {
      const list = suppliersFromSheet(await readSheet(file))
      if (!list.length) { toast('No rows with a valid GSTIN found in that file'); return }
      const { error } = await db().from('suppliers').upsert(list.map(s => ({ ...s, firm_id: firm.id, client_id: client!.id })), { onConflict: 'client_id,gstin' })
      if (error) throw error
      await audit(firm.id, client!.id, null, email, 'Uploaded supplier list', `${file.name} · ${list.length} suppliers`)
      toast(`${list.length} suppliers saved. They are used from the next upload.`)
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
          <div className="eyebrow"><Link to="/">Clients</Link> · <Link to={`/clients/${client.id}/${currentReturnPeriod()}`}>{client.name}</Link></div>
          <h1>Client settings</h1>
          <p className="sub">{client.name} · <span className="mono">{client.gstin}</span></p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Past months</h2></div>
        {periods.filter(p => p.run_at).length === 0 ? <div className="empty">Nothing uploaded yet.</div> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Month</th><th>Status</th><th className="r">Matched</th><th className="r">ITC you may lose</th><th>Uploaded</th></tr></thead>
            <tbody>{periods.filter(p => p.run_at).map(p => {
              const s = p.summary as { counts?: Record<string, number>; itcAtRisk?: number; open?: number } | null
              return (
                <tr key={p.id} className="click" onClick={() => nav(`/clients/${client.id}/${p.period}`)}>
                  <td className="s1">{periodLabel(p.period)}</td>
                  <td><span className={`pill ${p.status === 'final' ? 'p-good' : s?.open ? 'p-warn' : 'p-info'}`}>{p.status === 'final' ? 'Closed' : s?.open ? `${s.open} issues to fix` : 'Ready to close'}</span></td>
                  <td className="r num">{s?.counts?.matched ?? '–'}</td>
                  <td className="r num">{s?.itcAtRisk != null ? inr(s.itcAtRisk) : '–'}</td>
                  <td className="num">{dmy(p.run_at)}</td>
                </tr>
              )
            })}</tbody>
          </table></div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Supplier list</h2><span className="small muted">{supplierCount} saved</span></div>
        <div className="panel-body">
          <p className="small muted" style={{ margin: 0 }}>
            Optional. Lets GSTFlow flag cancelled GSTINs and blocked credits. CSV or Excel with columns <code>gstin</code>, <code>name</code>,{' '}
            <code>registration_status</code>, <code>cancelled_on</code>, <code>category</code>.{' '}
            <a href={`${import.meta.env.BASE_URL}samples/supplier_master.csv`} download>Sample file</a>
          </p>
          <input type="file" id="suppliers" accept=".csv,.xlsx,.xls" onChange={e => e.target.files?.[0] && uploadSuppliers(e.target.files[0])} />
        </div>
      </section>

      {member.role === 'admin' && (
        <section className="panel">
          <div className="panel-head"><h2>Delete client</h2></div>
          <div className="panel-body">
            <p className="small muted" style={{ margin: 0 }}>Deletes {client.name} with all months, uploads, answers and history. This cannot be undone.</p>
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
