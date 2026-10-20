import { useEffect, useMemo, useRef, useState } from 'react'
import { errorText, Hint, useToast } from '../components/ui'
import { periodLabel } from '../engine/format'
import {
  autoMap, FIELDS, mapFromSaved, missingFields, read2b, readSheet, registerDocs, savedFromMap,
  type B2BData, type ColumnMap, type Sheet,
} from '../engine/parse'
import { validate } from '../engine/reconcile'
import { ensurePeriod, run2bFirst, runReconciliation } from '../lib/data'
import { useFirm } from '../lib/session'
import type { Client, Period } from '../lib/types'

interface Props { client: Client; month: string; period: Period | null; final: boolean; onDone: () => Promise<void> }

const sample = (name: string) => `${import.meta.env.BASE_URL}samples/${name}`

export default function UploadStep({ client, month, period, final, onDone }: Props) {
  const { email } = useFirm()
  const toast = useToast()
  const [hasRegister, setHasRegister] = useState(client.mode !== '2b_first')
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [map, setMap] = useState<ColumnMap | null>(null)
  const [showMap, setShowMap] = useState(false)
  const [b2b, setB2b] = useState<B2BData | null>(null)
  const [b2bName, setB2bName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showProblems, setShowProblems] = useState(false)
  const autoRan = useRef(false)
  const replacing = !!period?.run_at

  async function onRegister(file: File) {
    setError('')
    try {
      const s = await readSheet(file)
      if (!s.headers.length) throw new Error('This file looks empty.')
      setSheet(s)
      setMap(mapFromSaved(s.headers, client.column_map) ?? autoMap(s.headers))
    } catch (e) { setError(`Could not read the purchase register: ${errorText(e)}`) }
  }

  async function on2b(file: File) {
    setError('')
    try {
      setB2b(await read2b(file))
      setB2bName(file.name)
    } catch (e) { setError(`Could not read GSTR-2B: ${errorText(e)}`) }
  }

  const docs = useMemo(() => (sheet && map ? registerDocs(sheet, map) : []), [sheet, map])
  const missing = map ? missingFields(map) : []
  const problems = useMemo(() => (missing.length ? [] : validate(docs)), [docs, missing.length])
  const wrong: string[] = []
  if (b2b?.clientGstin && b2b.clientGstin !== client.gstin) wrong.push(`This GSTR-2B is for GSTIN ${b2b.clientGstin}, not ${client.name} (${client.gstin}).`)
  if (b2b?.period && b2b.period !== month) wrong.push(`This GSTR-2B is for ${periodLabel(b2b.period)}, not ${periodLabel(month)}.`)

  const ready = !!b2b && wrong.length === 0 && (!hasRegister || (docs.length > 0 && missing.length === 0))

  async function run() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const p = await ensurePeriod(client, month)
      if (hasRegister) {
        const s = await runReconciliation({
          client, period: p, email, register: docs, b2b: b2b!, registerFile: sheet!.fileName, b2bFile: b2bName,
          columnMap: savedFromMap(sheet!.headers, map!),
        })
        toast(`Matched ${s.counts.matched} invoices. ${s.open} need your decision.`)
      } else {
        await run2bFirst({ client, period: p, email, b2b: b2b!, b2bFile: b2bName })
      }
      await onDone()
    } catch (e) {
      setError(`Saving failed: ${errorText(e)}`)
      setBusy(false)
    }
  }

  // First upload of the month: start matching as soon as both files are in and look right.
  useEffect(() => {
    if (ready && !replacing && problems.length === 0 && !autoRan.current) { autoRan.current = true; run() }
  }) // eslint-disable-line react-hooks/exhaustive-deps

  if (final) return <div className="notice">{periodLabel(month)} is closed. Reopen it in step 3 to upload different files.</div>

  const showMapping = showMap || missing.length > 0

  return (
    <>
      <Hint id="upload">Upload the files and GSTFlow matches them straight away. Last month's unmatched invoices are included automatically.</Hint>

      <section className="panel">
        <div className="panel-body">
          <h2>Do you have the purchase register for {periodLabel(month)}?</h2>
          <div className="mode">
            <button className={hasRegister ? 'on' : ''} onClick={() => setHasRegister(true)}><b>Yes</b><span>Exported from Tally, Busy or Excel</span></button>
            <button className={!hasRegister ? 'on' : ''} onClick={() => setHasRegister(false)}><b>No, the books are messy</b><span>Use GSTR-2B and confirm each invoice with the client</span></button>
          </div>
        </div>
      </section>

      <div className="drops">
        {hasRegister && (
          <div className={`drop ${sheet && !missing.length ? 'ready' : ''}`}>
            <span className="eyebrow">Purchase register · CSV or Excel</span>
            <input type="file" id="register-file" accept=".csv,.xlsx,.xls" onChange={e => e.target.files?.[0] && onRegister(e.target.files[0])} />
            {sheet && !missing.length
              ? <span className="small">✓ Read <b>{docs.length} invoices</b> from {sheet.fileName} · <button className="link" onClick={() => setShowMap(!showMapping)}>{showMapping ? 'Hide columns' : 'Change columns'}</button></span>
              : !sheet && <span className="small muted">No file handy? <a href={sample('purchase_register_sep2026.csv')} download>Sample register</a></span>}
          </div>
        )}
        <div className={`drop ${b2b && !wrong.length ? 'ready' : ''}`}>
          <span className="eyebrow">GSTR-2B · JSON or Excel from the GST portal</span>
          <input type="file" id="b2b-file" accept=".json,.xlsx,.xls" onChange={e => e.target.files?.[0] && on2b(e.target.files[0])} />
          {b2b
            ? <span className="small">✓ Read <b>{b2b.docs.length} invoices</b> from {new Set(b2b.docs.map(d => d.gstin)).size} suppliers</span>
            : <span className="small muted">JSON works best. <a href={sample('gstr2b_sep2026.json')} download>Sample GSTR-2B</a></span>}
        </div>
      </div>

      {hasRegister && sheet && map && showMapping && (
        <section className="panel">
          <div className="panel-head"><h2>Which column is which?</h2>
            {missing.length > 0 && <span className="small" style={{ color: 'var(--bad)' }}>Pick a column for: {missing.join(', ')}</span>}</div>
          <div className="table-wrap"><table>
            <thead><tr><th>GSTFlow needs</th><th>Column in your file</th><th>First value</th></tr></thead>
            <tbody>{FIELDS.map(f => (
              <tr key={f.key}>
                <td>{f.label}{f.required && <span className="tag">required</span>}</td>
                <td><select className="input" id={`map-${f.key}`} value={map[f.key]} aria-label={`Column for ${f.label}`} onChange={e => setMap({ ...map, [f.key]: Number(e.target.value) })}>
                  <option value={-1}>Not in this file</option>
                  {sheet.headers.map((h, i) => h && <option key={i} value={i}>{h}</option>)}
                </select></td>
                <td className="mono muted">{map[f.key] >= 0 ? String(sheet.rows[0]?.[map[f.key]] ?? '') : ''}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="panel-body small muted">GSTFlow remembers this for {client.name} next month.</div>
        </section>
      )}

      {wrong.map(w => <div key={w} className="notice bad">{w}</div>)}
      {b2b?.notes.map(n => <div key={n} className="notice">{n}</div>)}
      {problems.length > 0 && (
        <div className="notice">
          {problems.length} row{problems.length > 1 ? 's have' : ' has'} a problem and may not match. <button className="link" onClick={() => setShowProblems(!showProblems)}>{showProblems ? 'Hide' : 'See rows'}</button>
          {showProblems && <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{problems.slice(0, 50).map(p => <li key={p}>{p}</li>)}</ul>}
        </div>
      )}
      {error && <div className="notice bad">{error}</div>}

      {(replacing || problems.length > 0 || busy) && (
        <div className="actions">
          <button className="btn primary" disabled={!ready || busy} onClick={run}>
            {busy ? 'Matching…' : replacing ? `Replace ${periodLabel(month)} results` : 'Continue anyway'}
          </button>
          {replacing && !busy && <span className="small muted">Replaces this month's decisions. The audit trail is kept.</span>}
        </div>
      )}
      {!ready && !busy && (
        <p className="small muted" style={{ margin: 0 }}>{hasRegister ? 'Add both files to start.' : 'Add GSTR-2B to start.'}</p>
      )}
    </>
  )
}
