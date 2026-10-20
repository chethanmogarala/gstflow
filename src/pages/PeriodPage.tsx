import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { periodLabel } from '../engine/format'
import { db } from '../lib/supabase'
import type { Client, Period } from '../lib/types'
import ImportPanel from './ImportPanel'
import TwoBFirst from './TwoBFirst'
import Workspace from './Workspace'

export default function PeriodPage() {
  const { clientId, periodId } = useParams()
  const [client, setClient] = useState<Client | null>(null)
  const [period, setPeriod] = useState<Period | null>(null)
  const [reimport, setReimport] = useState(false)

  const load = useCallback(async () => {
    const [{ data: c }, { data: p }] = await Promise.all([
      db().from('clients').select('*').eq('id', clientId).single(),
      db().from('periods').select('*').eq('id', periodId).single(),
    ])
    setClient(c)
    setPeriod(p)
  }, [clientId, periodId])
  useEffect(() => { load() }, [load])

  if (!client || !period) return <div className="empty">Loading…</div>

  const head = (
    <div className="eyebrow">
      <Link to="/">Clients</Link> · <Link to={`/clients/${client.id}`}>{client.name}</Link> · <span className="mono">{client.gstin}</span> · {periodLabel(period.period)}
    </div>
  )
  const done = () => { setReimport(false); load() }

  if (!period.run_at || reimport) {
    return <ImportPanel client={client} period={period} head={head} onDone={done} onCancel={period.run_at ? () => setReimport(false) : undefined} />
  }
  if (client.mode === '2b_first' && !period.register_file) {
    return <TwoBFirst client={client} period={period} head={head} onReimport={() => setReimport(true)} />
  }
  return <Workspace client={client} period={period} head={head} onReimport={() => setReimport(true)} onPeriodChange={load} />
}
