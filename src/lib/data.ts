// Database reads and writes for clients, periods and reconciliation runs.
import { previousPeriod } from '../engine/format'
import type { B2BData } from '../engine/parse'
import { carriesForward, reconcile, summarize } from '../engine/reconcile'
import type { Doc, Result, Supplier } from '../engine/types'
import { db } from './supabase'
import { openCount } from './todo'
import type { AuditEntry, Client, DocRow, Period, ResultRow, Row } from './types'

const PAGE = 1000

/** Supabase returns at most 1000 rows per request, so page through larger sets. */
async function all<T>(make: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await make(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

async function insertMany<T extends object>(table: string, rows: T[], select = 'id'): Promise<{ id: string }[]> {
  const out: { id: string }[] = []
  for (let i = 0; i < rows.length; i += 500) {
    const { data, error } = await db().from(table).insert(rows.slice(i, i + 500)).select(select)
    if (error) throw error
    out.push(...((data ?? []) as unknown as { id: string }[]))
  }
  return out
}

export function toDoc(d: DocRow, source = d.source): Doc {
  const igst = Number(d.igst), cgst = Number(d.cgst), sgst = Number(d.sgst)
  return {
    key: d.id, side: d.side, source, line: d.line ?? undefined, supplier: d.supplier ?? '', gstin: d.gstin,
    invoice: d.invoice, date: d.inv_date, taxable: Number(d.taxable), igst, cgst, sgst,
    tax: Math.round((igst + cgst + sgst) * 100) / 100, rcm: d.rcm, ledger: d.ledger ?? '',
  }
}

function docInsert(d: Doc, firm_id: string, period_id: string) {
  return {
    firm_id, period_id, side: d.side, source: d.source, line: d.line ?? null, supplier: d.supplier, gstin: d.gstin,
    invoice: d.invoice, inv_date: d.date, taxable: d.taxable, igst: d.igst, cgst: d.cgst, sgst: d.sgst,
    rcm: d.rcm, ledger: d.ledger || null,
  }
}

export async function audit(firm_id: string, client_id: string | null, period_id: string | null, user_email: string, action: string, detail = '') {
  await db().from('audit_log').insert({ firm_id, client_id, period_id, user_email, action, detail })
}

export async function loadMaster(client_id: string): Promise<Map<string, Supplier>> {
  const rows = await all<Supplier>((a, b) => db().from('suppliers').select('gstin,name,registration_status,cancelled_on,category').eq('client_id', client_id).range(a, b))
  return new Map(rows.map(s => [s.gstin, s]))
}

/** Last period's unmatched, still-claimable register rows, ready to match again. */
export async function loadCarryForward(client: Client, period: string): Promise<Doc[]> {
  const { data: prev } = await db().from('periods').select('id').eq('client_id', client.id).eq('period', previousPeriod(period)).maybeSingle()
  if (!prev) return []
  const results = await all<ResultRow>((a, b) => db().from('results').select('*').eq('period_id', prev.id).eq('status', 'only_in_register').range(a, b))
  const keep = results.filter(r => carriesForward(r) && r.decision !== 'Remove from register' && r.reg_doc)
  if (!keep.length) return []
  const ids = keep.map(r => r.reg_doc!)
  const docs: DocRow[] = []
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db().from('documents').select('*').in('id', ids.slice(i, i + 200))
    if (error) throw error
    docs.push(...(data ?? []))
  }
  return docs.map((d, i) => ({ ...toDoc(d, 'carry_forward'), key: `cf-${i}` }))
}

async function saveResults(firm_id: string, period_id: string, docs: Doc[], results: Result[]) {
  await db().from('documents').delete().eq('period_id', period_id)
  const inserted = await insertMany('documents', docs.map(d => docInsert(d, firm_id, period_id)))
  const idByKey = new Map(docs.map((d, i) => [d.key, inserted[i].id]))
  await insertMany('results', results.map(x => ({
    firm_id, period_id,
    reg_doc: x.reg ? idByKey.get(x.reg.key) ?? null : null,
    b2b_doc: x.b2b ? idByKey.get(x.b2b.key) ?? null : null,
    status: x.status, rule: x.rule, reason: x.reason, risks: x.risks,
    ims_suggested: x.ims, ims_why: x.imsWhy || null,
  })))
}

export async function runReconciliation(args: {
  client: Client; period: Period; email: string
  register: Doc[]; b2b: B2BData; registerFile: string; b2bFile: string
  columnMap: Record<string, string>
  /** Use these instead of last period's leftovers (sample data). */
  carryForward?: Doc[]
}) {
  const { client, period, email, register, b2b } = args
  const carryForward = args.carryForward ?? await loadCarryForward(client, period.period)
  const master = await loadMaster(client.id)
  const input = { register, carryForward, b2b: b2b.docs, filed: b2b.filed, master, clientGstin: client.gstin }
  const results = reconcile(input)
  const summary = { ...summarize(results, input), open: openCount(results) }
  await saveResults(client.firm_id, period.id, [...register, ...carryForward, ...b2b.docs], results)
  await db().from('periods').update({
    status: 'in_review', run_at: new Date().toISOString(), summary, register_file: args.registerFile, b2b_file: args.b2bFile,
  }).eq('id', period.id)
  await db().from('clients').update({ column_map: args.columnMap, mode: 'register' }).eq('id', client.id)
  const c = summary.counts
  await audit(client.firm_id, client.id, period.id, email, 'Ran reconciliation',
    `${args.registerFile} (${register.length} rows) vs ${args.b2bFile} (${b2b.docs.length} records), ${carryForward.length} carried forward → ` +
    `${c.matched} matched, ${c.probable} probable, ${c.only_in_register} only in register, ${c.only_in_2b} only in 2B`)
  return summary
}

/** 2B-first: every 2B invoice becomes a row for staff to confirm against the client's invoices. */
export async function run2bFirst(args: { client: Client; period: Period; email: string; b2b: B2BData; b2bFile: string }) {
  const { client, period, email, b2b } = args
  const results: Result[] = b2b.docs.map(b => ({
    reg: null, b2b: b, status: 'only_in_2b', rule: '2B-first', reason: "Check against the client's invoices",
    risks: [], ims: null, imsWhy: '', supplier: b.supplier, gstin: b.gstin,
  }))
  await saveResults(client.firm_id, period.id, b2b.docs, results)
  await db().from('periods').update({
    status: 'in_review', run_at: new Date().toISOString(), register_file: null, b2b_file: args.b2bFile,
    summary: { b2bRecords: b2b.docs.length, open: b2b.docs.length },
  }).eq('id', period.id)
  await db().from('clients').update({ mode: '2b_first' }).eq('id', client.id)
  await audit(client.firm_id, client.id, period.id, email, 'Imported GSTR-2B for 2B-first review', `${args.b2bFile} · ${b2b.docs.length} invoices`)
}

export async function addManualInvoice(client: Client, period: Period, email: string, doc: Omit<Doc, 'key' | 'side' | 'source'>) {
  const { data, error } = await db().from('documents')
    .insert(docInsert({ ...doc, key: 'manual', side: 'register', source: 'manual' }, client.firm_id, period.id)).select('id').single()
  if (error) throw error
  const { error: e2 } = await db().from('results').insert({
    firm_id: client.firm_id, period_id: period.id, reg_doc: data.id, status: 'only_in_register', rule: 'Added by staff',
    reason: 'Client has this invoice but it is not in GSTR-2B', risks: [], mark: 'have',
  })
  if (e2) throw e2
  await audit(client.firm_id, client.id, period.id, email, 'Added invoice not in 2B', `${doc.supplier} · ${doc.invoice} · GST ${doc.tax}`)
}

export async function loadRows(period_id: string): Promise<Row[]> {
  const [docs, results] = await Promise.all([
    all<DocRow>((a, b) => db().from('documents').select('*').eq('period_id', period_id).range(a, b)),
    all<ResultRow>((a, b) => db().from('results').select('*').eq('period_id', period_id).order('id').range(a, b)),
  ])
  const byId = new Map(docs.map(d => [d.id, d]))
  return results.map(r => {
    const reg = r.reg_doc && byId.get(r.reg_doc) ? toDoc(byId.get(r.reg_doc)!) : null
    const b2b = r.b2b_doc && byId.get(r.b2b_doc) ? toDoc(byId.get(r.b2b_doc)!) : null
    return { ...r, risks: r.risks ?? [], reg, b2b, supplier: reg?.supplier || b2b?.supplier || '', gstin: (reg ?? b2b)?.gstin ?? '' }
  })
}

export async function updateResult(id: string, patch: Partial<ResultRow>) {
  const { error } = await db().from('results').update(patch).eq('id', id)
  if (error) throw error
}

export async function loadAudit(period_id: string): Promise<AuditEntry[]> {
  const { data, error } = await db().from('audit_log').select('id,user_email,action,detail,at').eq('period_id', period_id).order('at', { ascending: false }).limit(500)
  if (error) throw error
  return data ?? []
}

/** The period row for a client and month, created on first use. */
export async function ensurePeriod(client: Client, period: string): Promise<Period> {
  const { data } = await db().from('periods').select('*').eq('client_id', client.id).eq('period', period).maybeSingle()
  if (data) return data
  const { data: created, error } = await db().from('periods').insert({ firm_id: client.firm_id, client_id: client.id, period }).select().single()
  if (error) throw error
  return created
}

/** Keep the clients list in step with review progress. */
export async function saveProgress(period: Period, rows: Row[], itcAtRisk: number) {
  await db().from('periods').update({ summary: { ...(period.summary ?? {}), open: openCount(rows), itcAtRisk } }).eq('id', period.id)
}
