// Turns a stored result back into the step-by-step reasoning shown in the review drawer.
import { inr, dmy, periodLabel } from '../engine/format'
import { invLoose, invStrict, needsFollowUp, RULES, TOLERANCE } from '../engine/reconcile'
import type { Row } from './types'

export interface Step { name: string; ok: boolean | null; text: string }

const ORDER = [RULES.exact, RULES.format, RULES.value, RULES.sameAmounts]

export function explain(r: Row): Step[] {
  if (r.rule === RULES.duplicate) return [{ name: 'Pre-check · Duplicates', ok: true, text: 'Same GSTIN and invoice number already appear earlier in the register, so this copy is kept out of matching' }]
  if (r.rule === RULES.rcm) return [{ name: 'Pre-check · Reverse charge', ok: true, text: 'Marked as reverse charge in the register. Suppliers do not report these, so it is not looked for in 2B' }]
  if (r.rule === '2B-first' || r.rule === 'Added by staff') return [{ name: r.rule, ok: null, text: r.reason }]
  const steps: Step[] = [{ name: 'Pre-checks', ok: null, text: 'Not a duplicate and not reverse charge, so it goes into matching' }]
  for (const name of ORDER) {
    if (!(r.reg && r.b2b)) {
      steps.push({ name, ok: false, text: r.reg ? 'No unmatched 2B invoice from this GSTIN fits' : 'No unmatched register row from this GSTIN fits' })
      continue
    }
    if (name === r.rule) { steps.push({ name, ok: true, text: r.reason }); return steps }
    let text = ''
    const amountsDiffer = Math.abs(r.reg.taxable - r.b2b.taxable) > TOLERANCE || Math.abs(r.reg.tax - r.b2b.tax) > TOLERANCE
    if (name === RULES.exact) text = invStrict(r.reg.invoice) !== invStrict(r.b2b.invoice)
      ? `Invoice numbers differ as written (${invStrict(r.reg.invoice)} vs ${invStrict(r.b2b.invoice)})` : `Amounts differ by more than ₹${TOLERANCE}`
    if (name === RULES.format) text = invLoose(r.reg.invoice) !== invLoose(r.b2b.invoice) ? 'Numbers differ even after cleanup' : amountsDiffer ? 'Same number after cleanup, but amounts differ' : 'Not applicable'
    if (name === RULES.value) text = 'Invoice numbers do not match'
    steps.push({ name, ok: false, text })
  }
  steps.push({ name: 'Result: no match', ok: null, text: r.reason })
  return steps
}

export interface SupplierGroup { supplier: string; gstin: string; items: Row[]; tax: number; valueIssue: boolean }

export function supplierGroups(rows: Row[]): SupplierGroup[] {
  const g = new Map<string, SupplierGroup>()
  for (const r of rows) {
    const manual = r.rule === 'Added by staff'
    if (!(needsFollowUp(r) || manual)) continue
    const x = g.get(r.gstin) ?? { supplier: r.supplier, gstin: r.gstin, items: [], tax: 0, valueIssue: false }
    x.items.push(r)
    if (r.rule === RULES.value) { x.valueIssue = true; x.tax += Math.abs((r.b2b?.tax ?? 0) - (r.reg?.tax ?? 0)) }
    else x.tax += r.reg?.tax ?? 0
    g.set(r.gstin, x)
  }
  return [...g.values()].sort((a, b) => b.tax - a.tax)
}

export function supplierMessage(g: SupplierGroup, clientName: string, clientGstin: string, period: string): string {
  const lines = g.items.map(x => {
    if (x.b2b && x.reg) return `- ${x.b2b.invoice} dated ${dmy(x.b2b.date)}: your GSTR-1 shows taxable ${inr(x.b2b.taxable)}, our books show ${inr(x.reg.taxable)}. Please confirm, and amend or issue a credit note if needed.`
    const r = x.reg!
    return `- ${r.invoice} dated ${dmy(r.date)}, taxable ${inr(r.taxable)}, GST ${inr(r.tax)}: not showing in our GSTR-2B. Please report it in your GSTR-1.`
  })
  return `Dear ${g.supplier} team,\n\nFor ${periodLabel(period)}, please look at the following invoices:\n${lines.join('\n')}\n\nThis lets us claim the input tax credit on time.\n\nThank you,\n${clientName} (GSTIN ${clientGstin})`
}

/** Decisions a reviewer can take, by status. */
export const DECISIONS: Record<Row['status'], string[]> = {
  matched: [],
  probable: ['Confirmed match', 'Not a match'],
  only_in_register: ['Chase supplier', 'Claim next period', 'Remove from register'],
  only_in_2b: ['Ask client', 'Add to register', 'Reject in IMS'],
}

export const isOpen = (r: Row) => r.status !== 'matched' && !r.decision
