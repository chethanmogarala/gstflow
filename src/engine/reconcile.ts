// Deterministic matching of a purchase register against GSTR-2B.
// Mirrors engine/reconcile.py: every result carries the rule that produced it and a plain reason.
import { inr, dmy } from './format'
import type { Doc, ImsAction, Result, Risk, RunInput, Status, Summary, Supplier } from './types'

/** Amounts within this many rupees count as equal. */
export const TOLERANCE = 1
/** Rule 4 looks for the same amounts within this many days. */
export const DATE_WINDOW_DAYS = 7

export const RULES = {
  exact: 'Rule 1 · Exact',
  format: 'Rule 2 · Invoice number format',
  value: 'Rule 3 · Value difference',
  sameAmounts: 'Rule 4 · Same amounts, different number',
  duplicate: 'Duplicate',
  rcm: 'Reverse charge',
  none: 'No match',
} as const

const BLOCKED_CATEGORIES = new Set(['food and catering', 'motor vehicles', 'club membership', 'personal consumption'])
const BLOCKED_LEDGER_WORDS = ['food', 'catering', 'canteen', 'club', 'gift', 'motor car']

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

/** Uppercase and drop separators: 'dss/26-27/0412' -> 'DSS26270412'. */
export const invStrict = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Also drop leading zeros in each part: 'SGP-0457' and 'SGP/457' -> 'SGP457'. */
export const invLoose = (raw: string) =>
  raw.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).map(p => p.replace(/^0+(?=.)/, '')).join('')

const close = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE
const sameAmounts = (r: Doc, b: Doc) => close(r.taxable, b.taxable) && close(r.tax, b.tax)
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000

function result(reg: Doc | null, b2b: Doc | null, status: Status, rule: string, reason: string): Result {
  const any = (reg ?? b2b)!
  return {
    reg, b2b, status, rule, reason, risks: [], ims: null, imsWhy: '',
    supplier: any.supplier || b2b?.supplier || '', gstin: any.gstin,
  }
}

export function validate(docs: Doc[]): string[] {
  const problems: string[] = []
  for (const d of docs) {
    const where = `${d.source === 'carry_forward' ? 'Carried forward' : 'Register'} row ${d.line ?? '?'}`
    if (!GSTIN_RE.test(d.gstin)) problems.push(`${where}: GSTIN "${d.gstin}" is not in a valid format`)
    if (!d.date) problems.push(`${where}: date could not be read`)
    if (d.taxable <= 0) problems.push(`${where}: taxable value is zero or missing`)
    if (!d.invoice) problems.push(`${where}: invoice number is missing`)
  }
  return problems
}

export function reconcile(input: RunInput): Result[] {
  const { register, carryForward, b2b, filed, master, clientGstin } = input
  const results: Result[] = []
  const seen = new Map<string, Doc>()
  const pool: Doc[] = []

  // Pre-checks: duplicates and reverse charge stay out of matching.
  for (const r of register) {
    const key = `${r.gstin}|${invStrict(r.invoice)}`
    const first = seen.get(key)
    if (first) {
      results.push(result(r, null, 'only_in_register', RULES.duplicate,
        `Same invoice entered twice in the purchase register (first at row ${first.line ?? '?'})`))
      continue
    }
    seen.set(key, r)
    if (r.rcm) {
      results.push(result(r, null, 'only_in_register', RULES.rcm,
        'Reverse charge purchase: the buyer pays this tax, so it is not expected in GSTR-2B'))
      continue
    }
    pool.push(r)
  }
  pool.push(...carryForward)

  const open2b = [...b2b]

  const take = (rule: string, test: (r: Doc, b: Doc) => boolean, status: Status, why: (r: Doc, b: Doc) => string) => {
    for (const r of [...pool]) {
      const i = open2b.findIndex(b => b.gstin === r.gstin && test(r, b))
      if (i < 0) continue
      const b = open2b[i]
      let reason = why(r, b)
      if (r.source === 'carry_forward') reason += '. Booked last period, matched across periods'
      results.push(result(r, b, status, rule, reason))
      pool.splice(pool.indexOf(r), 1)
      open2b.splice(i, 1)
    }
  }

  take(RULES.exact, (r, b) => invStrict(r.invoice) === invStrict(b.invoice) && sameAmounts(r, b), 'matched',
    () => 'GSTIN, invoice number and amounts all agree')
  take(RULES.format, (r, b) => invLoose(r.invoice) === invLoose(b.invoice) && sameAmounts(r, b), 'probable',
    (r, b) => `Invoice number written differently (${r.invoice} vs ${b.invoice}). Everything else agrees`)
  take(RULES.value, (r, b) => invLoose(r.invoice) === invLoose(b.invoice), 'probable',
    (r, b) => `Taxable value differs by ${inr(b.taxable - r.taxable)} and tax by ${inr(b.tax - r.tax)}`)
  take(RULES.sameAmounts,
    (r, b) => sameAmounts(r, b) && !!r.date && !!b.date && daysApart(r.date, b.date) <= DATE_WINDOW_DAYS, 'probable',
    (r, b) => `Same amounts within ${DATE_WINDOW_DAYS} days but invoice numbers differ (${r.invoice} vs ${b.invoice})`)

  for (const r of pool) {
    const m = master.get(r.gstin)
    let reason: string
    if (m && m.registration_status.toLowerCase() === 'cancelled' && m.cancelled_on && r.date && r.date > m.cancelled_on) {
      reason = `Supplier GSTIN was cancelled on ${dmy(m.cancelled_on)}, before this invoice date`
    } else if (filed.has(r.gstin)) {
      reason = 'Not in GSTR-2B. Supplier filed GSTR-1 but this invoice is missing from it'
    } else {
      reason = 'Not in GSTR-2B. Supplier has not filed GSTR-1 for this period'
    }
    if (r.source === 'carry_forward') reason += '. Carried forward from last period and still missing'
    results.push(result(r, null, 'only_in_register', RULES.none, reason))
  }

  const known = new Set<string>([...master.keys(), ...register.map(r => r.gstin), ...carryForward.map(r => r.gstin)])
  for (const b of open2b) {
    let reason = 'In GSTR-2B but not in the purchase register'
    if (!known.has(b.gstin)) reason += '. Supplier is unknown to the client'
    results.push(result(null, b, 'only_in_2b', RULES.none, reason))
  }

  for (const x of results) {
    x.risks = risksFor(x, master, clientGstin)
    const [ims, why] = imsFor(x, known)
    x.ims = ims
    x.imsWhy = why
  }
  return results
}

function risksFor(x: Result, master: Map<string, Supplier>, clientGstin: string): Risk[] {
  const risks: Risk[] = []
  const rec = (x.b2b ?? x.reg)!
  const tax = rec.tax
  const m = master.get(x.gstin)
  if (x.rule === RULES.duplicate) risks.push({ type: 'Duplicate', note: `Remove from the register to avoid claiming ${inr(tax)} twice` })
  if (x.rule === RULES.rcm) risks.push({ type: 'RCM', note: `Pay ${inr(tax)} under reverse charge in GSTR-3B, then claim it as ITC` })
  if (x.reason.toLowerCase().includes('cancelled')) risks.push({ type: 'Cancelled GSTIN', note: `Invoice dated after cancellation. ITC of ${inr(tax)} cannot be claimed` })
  const category = (m?.category ?? '').toLowerCase()
  const ledger = (x.reg?.ledger ?? '').toLowerCase()
  if (BLOCKED_CATEGORIES.has(category) || BLOCKED_LEDGER_WORDS.some(w => ledger.includes(w))) {
    risks.push({ type: 'Blocked 17(5)', note: `${m?.category || x.reg?.ledger}: exclude ${inr(tax)} from the ITC claim` })
  }
  const sameState = rec.gstin.slice(0, 2) === clientGstin.slice(0, 2)
  if (!sameState && (rec.cgst || rec.sgst)) risks.push({ type: 'Wrong tax type', note: 'Inter-state supplier charged CGST and SGST instead of IGST' })
  if (sameState && rec.igst) risks.push({ type: 'Wrong tax type', note: 'Same-state supplier charged IGST instead of CGST and SGST' })
  return risks
}

function imsFor(x: Result, known: Set<string>): [ImsAction | null, string] {
  if (!x.b2b) return [null, '']
  if (x.risks.some(r => r.type === 'Blocked 17(5)')) return ['Accept', 'Genuine invoice, but ITC is blocked: do not claim']
  if (x.status === 'matched') return ['Accept', 'Matches purchase register']
  if (x.rule === RULES.format) return ['Accept', 'Matches after cleaning the invoice number']
  if (x.status === 'probable') return ['Pending', 'Confirm the difference with the supplier first']
  if (!known.has(x.gstin)) return ['Reject', 'No purchase record and no history with this supplier']
  return ['Pending', 'Ask the client whether this was bought and booked']
}

/** Suppliers to chase: invoices missing from 2B (not cancelled) and value differences. */
export function needsFollowUp(x: Pick<Result, 'status' | 'rule' | 'risks'>): boolean {
  const missing = x.status === 'only_in_register' && x.rule === RULES.none && !x.risks.some(r => r.type === 'Cancelled GSTIN')
  return missing || x.rule === RULES.value
}

/** Register rows to carry into next period: still unmatched and still claimable. */
export function carriesForward(x: Pick<Result, 'status' | 'rule' | 'risks'>): boolean {
  return x.status === 'only_in_register' && x.rule === RULES.none && !x.risks.some(r => r.type === 'Cancelled GSTIN')
}

export function summarize(results: Result[], input: RunInput): Summary {
  const counts: Record<Status, number> = { matched: 0, probable: 0, only_in_register: 0, only_in_2b: 0 }
  const byRule: Record<string, number> = {}
  const ims: Record<ImsAction, number> = { Accept: 0, Reject: 0, Pending: 0 }
  let itcSafe = 0, itcReview = 0, itcAtRisk = 0
  const chase = new Set<string>()
  for (const x of results) {
    counts[x.status]++
    byRule[x.rule] = (byRule[x.rule] ?? 0) + 1
    if (x.ims) ims[x.ims]++
    if (x.status === 'matched') itcSafe += x.b2b!.tax
    if (x.status === 'probable') itcReview += x.b2b!.tax
    if (x.status === 'only_in_register' && x.rule !== RULES.rcm) itcAtRisk += x.reg!.tax
    if (x.b2b && x.risks.some(r => r.type === 'Blocked 17(5)')) itcAtRisk += x.b2b.tax
    if (needsFollowUp(x)) chase.add(x.gstin)
  }
  return {
    registerRows: input.register.length, carriedForward: input.carryForward.length, b2bRecords: input.b2b.length,
    counts, byRule, itcSafe, itcReview, itcAtRisk, ims, suppliersToChase: chase.size,
  }
}
