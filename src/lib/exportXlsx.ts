import * as XLSX from 'xlsx'
import { dmy, periodLabel } from '../engine/format'
import { supplierGroups, supplierMessage } from './explain'
import type { AuditEntry, Client, Period, Row } from './types'
import { STATUS } from '../components/ui'

const safe = (s: string) => s.replace(/[^\w-]+/g, '_').slice(0, 40)

function sheet(wb: XLSX.WorkBook, name: string, rows: (string | number | null)[][], widths: number[]) {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = widths.map(wch => ({ wch }))
  XLSX.utils.book_append_sheet(wb, ws, name)
}

export function exportReconciliation(client: Client, period: Period, rows: Row[], auditLog: AuditEntry[], summary: Record<string, unknown>) {
  const wb = XLSX.utils.book_new()
  sheet(wb, 'Summary', [
    ['GSTFlow reconciliation'], ['Client', client.name], ['GSTIN', client.gstin], ['Period', periodLabel(period.period)],
    ['Status', period.status], ['Exported', new Date().toLocaleString('en-IN')], [],
    ...Object.entries(summary).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : (v as string | number)]),
  ], [28, 60])
  sheet(wb, 'Reconciliation', [
    ['Status', 'Rule', 'Supplier', 'GSTIN', 'Register invoice', '2B invoice', 'Date', 'Register taxable', '2B taxable', 'Register tax', '2B tax', 'Reason', 'Risks', 'Decision', 'Note', 'Decided by'],
    ...rows.map(r => [r.rule === '2B-first' ? (r.mark === 'have' ? 'Client has it' : r.mark === 'not' ? 'Not ours' : r.mark === 'ask' ? 'Ask client' : 'Not checked') : STATUS[r.status].label, r.rule, r.supplier, r.gstin, r.reg?.invoice ?? '', r.b2b?.invoice ?? '', dmy((r.reg ?? r.b2b)?.date),
      r.reg?.taxable ?? null, r.b2b?.taxable ?? null, r.reg?.tax ?? null, r.b2b?.tax ?? null, r.reason,
      r.risks.map(x => x.type).join(', '), r.decision ?? '', r.note ?? '', r.decided_by ?? '']),
  ], [16, 30, 28, 18, 16, 16, 11, 14, 14, 12, 12, 60, 20, 18, 30, 24])
  sheet(wb, 'IMS actions', [
    ['Supplier', 'GSTIN', '2B invoice', 'Date', '2B tax', 'Action', 'Suggested', 'Why'],
    ...rows.filter(r => r.b2b && (r.ims_final ?? r.ims_suggested)).map(r => [r.supplier, r.gstin, r.b2b!.invoice, dmy(r.b2b!.date), r.b2b!.tax,
      r.ims_final ?? r.ims_suggested, r.ims_suggested ?? '', r.ims_why ?? '']),
  ], [28, 18, 16, 11, 12, 10, 10, 50])
  sheet(wb, 'ITC risks', [
    ['Flag', 'Supplier', 'GSTIN', 'Invoice', 'Tax', 'What to do'],
    ...rows.flatMap(r => r.risks.map(x => [x.type, r.supplier, r.gstin, (r.reg ?? r.b2b)!.invoice, (r.b2b ?? r.reg)!.tax, x.note])),
  ], [16, 28, 18, 16, 12, 70])
  sheet(wb, 'Supplier follow-up', [
    ['Supplier', 'GSTIN', 'Invoices', 'Message'],
    ...supplierGroups(rows).map(g => [g.supplier, g.gstin, g.items.length, supplierMessage(g, client.name, client.gstin, period.period)]),
  ], [28, 18, 10, 100])
  sheet(wb, 'Audit trail', [
    ['When', 'Who', 'Action', 'Details'],
    ...auditLog.map(a => [new Date(a.at).toLocaleString('en-IN'), a.user_email ?? '', a.action, a.detail ?? '']),
  ], [22, 28, 30, 90])
  XLSX.writeFile(wb, `GSTFlow_${safe(client.name)}_${period.period}.xlsx`)
}

/** Just the IMS decisions, one row per GSTR-2B invoice. */
export function exportIms(client: Client, period: Period, rows: Row[]) {
  const wb = XLSX.utils.book_new()
  sheet(wb, 'IMS actions', [
    ['Supplier GSTIN', 'Supplier', 'Invoice number', 'Invoice date', 'Taxable value', 'Tax', 'Action', 'Why'],
    ...rows.filter(r => r.b2b).map(r => [r.gstin, r.supplier, r.b2b!.invoice, dmy(r.b2b!.date), r.b2b!.taxable, r.b2b!.tax,
      r.ims_final ?? r.ims_suggested ?? 'Pending', r.ims_final && r.ims_final !== r.ims_suggested ? `Set by reviewer: ${r.decision ?? r.mark ?? ''}` : r.ims_why ?? '']),
  ], [18, 28, 16, 12, 14, 12, 10, 50])
  XLSX.writeFile(wb, `GSTFlow_${safe(client.name)}_${period.period}_IMS.xlsx`)
}

/** 2B-first: a clean purchase register (Tally-style columns) built from confirmed invoices. */
export function exportRegister(client: Client, period: Period, rows: Row[]) {
  const wb = XLSX.utils.book_new()
  const kept = rows.filter(r => r.mark === 'have')
  sheet(wb, 'Purchase register', [
    ['Party Name', 'GSTIN/UIN', 'Vch No.', 'Date', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Reverse Charge', 'Source'],
    ...kept.map(r => { const d = (r.b2b ?? r.reg)!; return [d.supplier, d.gstin, d.invoice, dmy(d.date), d.taxable, d.igst, d.cgst, d.sgst, d.rcm ? 'Y' : 'N', r.b2b ? 'GSTR-2B' : 'Added by staff'] }),
  ], [28, 18, 16, 11, 14, 10, 10, 10, 14, 16])
  sheet(wb, 'IMS actions', [
    ['Supplier', 'GSTIN', '2B invoice', 'Date', '2B tax', 'Action'],
    ...rows.filter(r => r.b2b && r.ims_final).map(r => [r.supplier, r.gstin, r.b2b!.invoice, dmy(r.b2b!.date), r.b2b!.tax, r.ims_final]),
  ], [28, 18, 16, 11, 12, 10])
  XLSX.writeFile(wb, `GSTFlow_${safe(client.name)}_${period.period}_register.xlsx`)
}
