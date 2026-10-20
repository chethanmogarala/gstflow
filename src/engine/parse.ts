// Reading purchase registers, GSTR-2B and supplier lists from CSV, Excel or JSON.
import * as XLSX from 'xlsx'
import { parseDate, toNum } from './format'
import { GSTIN_RE } from './reconcile'
import type { Doc, Source, Supplier } from './types'

export type Field = 'supplier' | 'gstin' | 'invoice' | 'date' | 'taxable' | 'igst' | 'cgst' | 'sgst' | 'rcm' | 'ledger'
export type ColumnMap = Record<Field, number>

export const FIELDS: { key: Field; label: string; required: boolean; hints: string[] }[] = [
  { key: 'supplier', label: 'Supplier name', required: true, hints: ['party name', 'supplier name', 'supplier', 'vendor name', 'vendor', 'party', 'name of supplier', 'particulars'] },
  { key: 'gstin', label: 'Supplier GSTIN', required: true, hints: ['gstin/uin', 'gstin uin', 'gstin', 'supplier gstin', 'gst no', 'gst number', 'gstin of supplier'] },
  { key: 'invoice', label: 'Invoice number', required: true, hints: ['vch no.', 'vch no', 'invoice no', 'invoice number', 'bill no', 'supplier invoice no', 'voucher no', 'inv no', 'reference no', 'supplier inv no'] },
  { key: 'date', label: 'Invoice date', required: true, hints: ['date', 'invoice date', 'bill date', 'vch date', 'inv date', 'voucher date'] },
  { key: 'taxable', label: 'Taxable value', required: true, hints: ['taxable value', 'taxable amount', 'taxable', 'assessable value', 'taxable val'] },
  { key: 'igst', label: 'IGST', required: false, hints: ['igst', 'integrated tax', 'igst amount'] },
  { key: 'cgst', label: 'CGST', required: false, hints: ['cgst', 'central tax', 'cgst amount'] },
  { key: 'sgst', label: 'SGST / UTGST', required: false, hints: ['sgst', 'state tax', 'sgst/utgst', 'state/ut tax', 'utgst', 'sgst amount'] },
  { key: 'rcm', label: 'Reverse charge (Y/N)', required: false, hints: ['reverse charge', 'rcm', 'reverse charge applicable'] },
  { key: 'ledger', label: 'Ledger / description', required: false, hints: ['ledger', 'purchase ledger', 'ledger name', 'description', 'narration'] },
]

export interface Sheet {
  fileName: string
  sheetName: string
  headerRow: number
  headers: string[]
  rows: unknown[][]
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[₹()]/g, ' ').replace(/\s+/g, ' ').trim()

export function workbookFromBuffer(buf: ArrayBuffer | Uint8Array, fileName = ''): XLSX.WorkBook {
  if (/\.(csv|txt)$/i.test(fileName)) {
    // Keep CSV cells as text: the default parser reads 10-08-2026 as 8 October (US order).
    const text = new TextDecoder('utf-8').decode(buf).replace(/^﻿/, '')
    return XLSX.read(text, { type: 'string', raw: true })
  }
  return XLSX.read(buf, { type: 'array', cellDates: true })
}

function grid(wb: XLSX.WorkBook, sheetName: string): unknown[][] {
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true }) as unknown[][]
}

/** The first row within the top 30 that looks most like a header. */
function findHeaderRow(cells: unknown[][], hints: string[]): number {
  let best = 0, bestScore = 0
  for (let i = 0; i < Math.min(30, cells.length); i++) {
    const score = cells[i].filter(c => { const n = norm(c); return n && hints.some(h => n === h || n.includes(h)) }).length
    if (score > bestScore) { best = i; bestScore = score }
  }
  return best
}

export function sheetFromWorkbook(wb: XLSX.WorkBook, fileName: string, hints = FIELDS.flatMap(f => f.hints)): Sheet {
  const sheetName = wb.SheetNames.find(n => /purchase|register|sheet1/i.test(n)) ?? wb.SheetNames[0]
  const cells = grid(wb, sheetName)
  const headerRow = findHeaderRow(cells, hints)
  const headers = (cells[headerRow] ?? []).map(c => String(c ?? '').trim())
  const rows = cells.slice(headerRow + 1).filter(r => r.some(c => c !== '' && c != null))
  return { fileName, sheetName, headerRow, headers, rows }
}

export async function readSheet(file: File): Promise<Sheet> {
  return sheetFromWorkbook(workbookFromBuffer(await file.arrayBuffer(), file.name), file.name)
}

/** Guess which column holds each field. Exact header matches win over partial ones. */
export function autoMap(headers: string[]): ColumnMap {
  const used = new Set<number>()
  const map = {} as ColumnMap
  const h = headers.map(norm)
  for (const f of FIELDS) {
    let idx = h.findIndex((x, i) => !used.has(i) && f.hints.includes(x))
    if (idx < 0) idx = h.findIndex((x, i) => !used.has(i) && x !== '' && f.hints.some(hint => hint.length > 3 && x.includes(hint)))
    map[f.key] = idx
    if (idx >= 0) used.add(idx)
  }
  return map
}

/** Re-apply a saved mapping (stored as header names) to this file's headers. */
export function mapFromSaved(headers: string[], saved: Partial<Record<Field, string>> | null | undefined): ColumnMap | null {
  if (!saved) return null
  const map = {} as ColumnMap
  for (const f of FIELDS) {
    const name = saved[f.key]
    map[f.key] = name ? headers.findIndex(x => norm(x) === norm(name)) : -1
    if (f.required && map[f.key] < 0) return null
  }
  return map
}

export function savedFromMap(headers: string[], map: ColumnMap): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {}
  for (const f of FIELDS) if (map[f.key] >= 0) out[f.key] = headers[map[f.key]]
  return out
}

export function missingFields(map: ColumnMap): string[] {
  const missing = FIELDS.filter(f => f.required && map[f.key] < 0).map(f => f.label)
  if (map.igst < 0 && map.cgst < 0 && map.sgst < 0) missing.push('at least one tax column (IGST, CGST or SGST)')
  return missing
}

export function registerDocs(sheet: Sheet, map: ColumnMap, source: Source = 'register'): Doc[] {
  const get = (row: unknown[], f: Field) => (map[f] >= 0 ? row[map[f]] : '')
  const docs: Doc[] = []
  sheet.rows.forEach((row, i) => {
    const gstin = String(get(row, 'gstin') ?? '').toUpperCase().replace(/\s/g, '')
    const invoice = String(get(row, 'invoice') ?? '').trim()
    const supplier = String(get(row, 'supplier') ?? '').trim()
    if (!gstin && !invoice) return
    if (/^(grand\s*)?total/i.test(supplier)) return
    const igst = toNum(get(row, 'igst')), cgst = toNum(get(row, 'cgst')), sgst = toNum(get(row, 'sgst'))
    const line = sheet.headerRow + i + 2
    docs.push({
      key: `${source}-${line}`, side: 'register', source, line, supplier, gstin, invoice,
      date: parseDate(get(row, 'date')), taxable: toNum(get(row, 'taxable')),
      igst, cgst, sgst, tax: round2(igst + cgst + sgst),
      rcm: /^(y|yes|true|1)$/i.test(String(get(row, 'rcm') ?? '').trim()),
      ledger: String(get(row, 'ledger') ?? '').trim(),
    })
  })
  return docs
}

const round2 = (n: number) => Math.round(n * 100) / 100

export interface B2BData {
  clientGstin: string | null
  period: string | null
  docs: Doc[]
  filed: Set<string>
  notes: string[]
}

interface B2BInvoiceJson { inum: string; dt: string; txval: number; igst?: number; cgst?: number; sgst?: number; rev?: string }
interface B2BSupplierJson { ctin: string; trdnm?: string; supfildt?: string; inv?: B2BInvoiceJson[] }

export function b2bFromJson(text: string): B2BData {
  const j = JSON.parse(text)
  const data = j.data ?? j
  const docdata = data.docdata ?? data
  const docs: Doc[] = []
  const filed = new Set<string>()
  const notes: string[] = []
  const suppliers: B2BSupplierJson[] = docdata.b2b ?? []
  for (const s of suppliers) {
    const gstin = String(s.ctin).toUpperCase()
    if (s.supfildt) filed.add(gstin)
    for (const inv of s.inv ?? []) {
      const igst = inv.igst ?? 0, cgst = inv.cgst ?? 0, sgst = inv.sgst ?? 0
      docs.push({
        key: `2b-${docs.length + 1}`, side: '2b', source: '2b', supplier: s.trdnm ?? '', gstin,
        invoice: String(inv.inum), date: parseDate(inv.dt), taxable: Number(inv.txval) || 0,
        igst, cgst, sgst, tax: round2(igst + cgst + sgst), rcm: inv.rev === 'Y', ledger: '',
      })
    }
  }
  const cdn = (docdata.cdnr ?? []).reduce((n: number, s: { nt?: unknown[] }) => n + (s.nt?.length ?? 0), 0)
  if (cdn) notes.push(`${cdn} credit/debit note(s) in this 2B are not reconciled yet in this version`)
  if (!suppliers.length) notes.push('No B2B invoices found in this file')
  return { clientGstin: data.gstin ?? null, period: data.rtnprd ?? null, docs, filed, notes }
}

const B2B_EXCEL: Partial<Record<Field, string[]>> & { filed: string[] } = {
  gstin: ['gstin of supplier'],
  supplier: ['trade/legal name', 'trade legal name', 'trade name'],
  invoice: ['invoice number', 'invoice no'],
  date: ['invoice date'],
  taxable: ['taxable value'],
  igst: ['integrated tax'],
  cgst: ['central tax'],
  sgst: ['state/ut tax', 'state ut tax', 'state tax'],
  rcm: ['reverse charge'],
  filed: ['filing date'],
}

/** The B2B sheet of the portal's GSTR-2B Excel download. Its header spans two rows. */
export function b2bFromWorkbook(wb: XLSX.WorkBook): B2BData {
  const sheetName = wb.SheetNames.find(n => n.trim().toUpperCase() === 'B2B') ?? wb.SheetNames.find(n => /b2b/i.test(n))
  if (!sheetName) throw new Error('No "B2B" sheet found. Upload the GSTR-2B Excel or JSON from the GST portal.')
  const cells = grid(wb, sheetName)
  const allHints = Object.values(B2B_EXCEL).flat()
  const h = findHeaderRow(cells, allHints)
  const headers = (cells[h] ?? []).map((c, i) => `${norm(c)} ${norm(cells[h + 1]?.[i])}`.trim())
  const col = (hints: string[]) => headers.findIndex(x => hints.some(hint => x.includes(hint)))
  const idx = Object.fromEntries(Object.entries(B2B_EXCEL).map(([k, v]) => [k, col(v)])) as Record<string, number>
  if (idx.gstin < 0 || idx.invoice < 0 || idx.taxable < 0) throw new Error('Could not find GSTIN, invoice number and taxable value columns in the B2B sheet.')
  const docs: Doc[] = []
  const filed = new Set<string>()
  for (const row of cells.slice(h + 1)) {
    const gstin = String(row[idx.gstin] ?? '').toUpperCase().trim()
    if (!GSTIN_RE.test(gstin)) continue
    const v = (k: string) => (idx[k] >= 0 ? row[idx[k]] : '')
    const igst = toNum(v('igst')), cgst = toNum(v('cgst')), sgst = toNum(v('sgst'))
    if (v('filed')) filed.add(gstin)
    docs.push({
      key: `2b-${docs.length + 1}`, side: '2b', source: '2b', supplier: String(v('supplier') ?? '').trim(), gstin,
      invoice: String(v('invoice') ?? '').trim(), date: parseDate(v('date')), taxable: toNum(v('taxable')),
      igst, cgst, sgst, tax: round2(igst + cgst + sgst), rcm: /^y/i.test(String(v('rcm') ?? '')), ledger: '',
    })
  }
  return { clientGstin: null, period: null, docs, filed, notes: docs.length ? [] : ['No B2B invoices found in this file'] }
}

export async function read2b(file: File): Promise<B2BData> {
  if (/\.json$/i.test(file.name)) return b2bFromJson(await file.text())
  return b2bFromWorkbook(workbookFromBuffer(await file.arrayBuffer()))
}

/** Supplier list: gstin, name, registration_status, cancelled_on, category. */
export function suppliersFromSheet(sheet: Sheet): Supplier[] {
  const h = sheet.headers.map(norm)
  const at = (...names: string[]) => h.findIndex(x => names.some(n => x === n || x.includes(n)))
  const g = at('gstin'), n = at('name', 'supplier'), st = at('registration_status', 'status'), c = at('cancelled_on', 'cancelled', 'cancellation'), cat = at('category', 'type')
  if (g < 0) throw new Error('The supplier list needs a GSTIN column.')
  return sheet.rows
    .map(r => ({
      gstin: String(r[g] ?? '').toUpperCase().trim(),
      name: n >= 0 ? String(r[n] ?? '').trim() : null,
      registration_status: st >= 0 && String(r[st] ?? '').trim() ? String(r[st]).trim() : 'Active',
      cancelled_on: c >= 0 ? parseDate(r[c]) : null,
      category: cat >= 0 ? String(r[cat] ?? '').trim() || null : null,
    }))
    .filter(s => GSTIN_RE.test(s.gstin))
}
