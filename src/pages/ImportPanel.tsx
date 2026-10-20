import { useMemo, useState, type ReactNode } from 'react'
import { errorText, useToast } from '../components/ui'
import { dmy, periodLabel } from '../engine/format'
import {
  autoMap, FIELDS, mapFromSaved, missingFields, read2b, readSheet, registerDocs, savedFromMap,
  type B2BData, type ColumnMap, type Sheet,
} from '../engine/parse'
import { validate } from '../engine/reconcile'
import { run2bFirst, runReconciliation } from '../lib/data'
import { useFirm } from '../lib/session'
import type { Client, Period } from '../lib/types'

interface Props { client: Client; period: Period; head: ReactNode; onDone: () => void; onCancel?: () => void }

const sample = (name: string) => `${import.meta.env.BASE_URL}samples/${name}`

export default function ImportPanel({ client, period, head, onDone, onCancel }: Props) {
  const { email } = useFirm()
  const toast = useToast()
  const twoBFirst = client.mode === '2b_first'
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [map, setMap] = useState<ColumnMap | null>(null)
  const [savedUsed, setSavedUsed] = useState(false)
  const [b2b, setB2b] = useState<B2BData | null>(null)
  const [b2bName, setB2bName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onRegister(file: File) {
    setError('')
    try {
      const s = await readSheet(file)
      if (!s.headers.length) throw new Error('This file looks empty.')
      const saved = mapFromSaved(s.headers, client.column_map)
      setSheet(s)
      setMap(saved ?? autoMap(s.headers))
      setSavedUsed(!!saved)
    } catch (e) { setError(`Could not read the purchase register: ${errorText(e)}`) }
  }

  async function on2b(file: File) {
    setError('')
    try {
      const data = await read2b(file)
      setB2b(data)
      setB2bName(file.name)
    } catch (e) { setError(`Could not read GSTR-2B: ${errorText(e)}`) }
  }

  const docs = useMemo(() => (sheet && map ? registerDocs(sheet, map) : []), [sheet, map])
  const missing = map ? missingFields(map) : []
  const problems = useMemo(() => validate(docs), [docs])
  const outOfPeriod = docs.filter(d => d.date && d.date.slice(5, 7) + d.date.slice(0, 4) !== period.period).length
  const warnings: string[] = []
  if (b2b?.clientGstin && b2b.clientGstin !== client.gstin) warnings.push(`This GSTR-2B belongs to GSTIN ${b2b.clientGstin}, not this client (${client.gstin}).`)
  if (b2b?.period && b2b.period !== period.period) warnings.push(`This GSTR-2B is for ${periodLabel(b2b.period)}, not ${periodLabel(period.period)}.`)

  const ready = twoBFirst ? !!b2b : !!sheet && !!b2b && docs.length > 0 && missing.length === 0

  async function run() {
    setBusy(true); setError('')
    try {
      if (twoBFirst) {
        await run2bFirst({ client, period, email, b2b: b2b!, b2bFile: b2bName })
      } else {
        const s = await runReconciliation({
          client, period, email, register: docs, b2b: b2b!, registerFile: sheet!.fileName, b2bFile: b2bName,
          columnMap: savedFromMap(sheet!.headers, map!),
        })
        toast(`Done: ${s.counts.matched} matched, ${s.counts.probable} probable, ${s.counts.only_in_register + s.counts.only_in_2b} unmatched`)
      }
      onDone()
    } catch (e) {
      setError(`Saving failed: ${errorText(e)}`)
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className="head">
        <div>{head}<h1>Import files</h1>
          <p className="sub">{twoBFirst
            ? "This client is in 2B-first mode: upload GSTR-2B, then confirm each invoice against the client's papers."
            : 'Upload the purchase register and GSTR-2B. Last period’s unmatched invoices are added automatically.'}</p>
        </div>
        {onCancel && <div className="actions"><button className="btn" onClick={onCancel}>Back to results</button></div>}
      </div>

      {period.run_at && <div className="notice bad">Running again replaces this period's results, including review decisions. The audit trail is kept.</div>}

      <div className="drops">
        {!twoBFirst && (
          <div className={`drop ${sheet ? 'ready' : ''}`}>
            <span className="eyebrow">Purchase register · CSV or Excel</span>
            <input type="file" id="register-file" accept=".csv,.xlsx,.xls" onChange={e => e.target.files?.[0] && onRegister(e.target.files[0])} />
            {sheet ? <span className="small"><b>{sheet.fileName}</b> · {docs.length} invoices · header found on row {sheet.headerRow + 1}</span>
              : <span className="small muted">Export from Tally, Busy or Excel. <a href={sample('purchase_register_sep2026.csv')} download>Sample file</a></span>}
          </div>
        )}
        <div className={`drop ${b2b ? 'ready' : ''}`}>
          <span className="eyebrow">GSTR-2B · JSON or Excel from the GST portal</span>
          <input type="file" id="b2b-file" accept=".json,.xlsx,.xls" onChange={e => e.target.files?.[0] && on2b(e.target.files[0])} />
          {b2b ? <span className="small"><b>{b2bName}</b> · {b2b.docs.length} invoices from {new Set(b2b.docs.map(d => d.gstin)).size} suppliers</span>
            : <span className="small muted">JSON is most reliable. <a href={sample('gstr2b_sep2026.json')} download>Sample file</a></span>}
        </div>
      </div>

      {!twoBFirst && sheet && map && (
        <section className="panel">
          <div className="panel-head"><h2>Column mapping</h2>{savedUsed ? <span className="pill p-good">Saved from last time</span> : <span className="pill p-info">Detected automatically</span>}</div>
          <div className="table-wrap"><table>
            <thead><tr><th>GSTFlow field</th><th>Column in your file</th><th>First value</th></tr></thead>
            <tbody>
              {FIELDS.map(f => (
                <tr key={f.key}>
                  <td>{f.label}{f.required && <span className="tag">required</span>}</td>
                  <td>
                    <select className="input" id={`map-${f.key}`} value={map[f.key]} aria-label={`Column for ${f.label}`}
                      onChange={e => setMap({ ...map, [f.key]: Number(e.target.value) })}>
                      <option value={-1}>Not in this file</option>
                      {sheet.headers.map((h, i) => h && <option key={i} value={i}>{h}</option>)}
                    </select>
                  </td>
                  <td className="mono muted">{map[f.key] >= 0 ? String(sheet.rows[0]?.[map[f.key]] ?? '') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}

      {(sheet || b2b) && (
        <section className="panel">
          <div className="panel-head"><h2>Checks</h2></div>
          <div className="panel-body"><ul className="checks">
            {!twoBFirst && sheet && (missing.length
              ? <li><span className="pill p-bad">Fix</span> Map these fields: {missing.join(', ')}</li>
              : <li><span className="pill p-good">OK</span> {docs.length} register rows read{docs.length ? `, dates ${dmy(docs.map(d => d.date ?? '').filter(Boolean).sort()[0])} to ${dmy(docs.map(d => d.date ?? '').sort().at(-1))}` : ''}</li>)}
            {!missing.length && problems.length > 0 && <li><span className="pill p-warn">Check</span> {problems.length} row problem(s): {problems.slice(0, 5).join('; ')}{problems.length > 5 ? '…' : ''}</li>}
            {!missing.length && outOfPeriod > 0 && <li><span className="pill p-info">Info</span> {outOfPeriod} invoice(s) dated outside {periodLabel(period.period)}. They are still matched.</li>}
            {b2b && <li><span className="pill p-good">OK</span> GSTR-2B: {b2b.docs.length} invoices, {b2b.filed.size} suppliers filed GSTR-1</li>}
            {b2b?.notes.map(n => <li key={n}><span className="pill p-info">Info</span> {n}</li>)}
            {warnings.map(w => <li key={w}><span className="pill p-bad">Check</span> {w}</li>)}
          </ul></div>
        </section>
      )}

      {error && <div className="notice bad">{error}</div>}
      <div className="actions">
        <button className="btn primary" disabled={!ready || busy} onClick={run}>
          {busy ? 'Working…' : twoBFirst ? 'Start 2B-first review' : 'Run reconciliation'}
        </button>
        {!ready && <span className="small muted">{twoBFirst ? 'Upload GSTR-2B to continue.' : 'Upload both files and map the required columns to continue.'}</span>}
      </div>
    </>
  )
}
