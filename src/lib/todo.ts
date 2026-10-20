// Groups reconciliation results into the to-do list the reviewer works through,
// and defines what each button does (decision text + IMS action).
import { RULES } from '../engine/reconcile'
import type { ImsAction, Risk, Status } from '../engine/types'

export type GroupKey = 'fix' | 'check' | 'missing' | 'notInBooks' | 'confirm2b'

export interface Option {
  label: string
  decision: string
  ims?: ImsAction
  help: string
}

/** The fields grouping needs, so it works on engine results and stored rows alike. */
export interface Classifiable {
  status: Status
  rule: string
  risks: Risk[]
  decision?: string | null
  mark?: string | null
  b2b?: unknown
}

export const GROUPS: Record<GroupKey, { title: string; intro: string }> = {
  fix: {
    title: 'Fix before claiming',
    intro: 'These invoices have a problem that changes how much ITC can be claimed.',
  },
  check: {
    title: 'Check small differences',
    intro: 'The register and GSTR-2B almost agree. Confirm whether they are the same invoice.',
  },
  missing: {
    title: "Suppliers haven't reported these",
    intro: 'In the purchase register but not in GSTR-2B, so the ITC cannot be claimed yet.',
  },
  notInBooks: {
    title: "Not in the client's books",
    intro: "Suppliers reported these in GSTR-2B, but they are not in the purchase register.",
  },
  confirm2b: {
    title: 'Confirm each invoice in GSTR-2B',
    intro: "Check each one against the client's papers. Your answer becomes the IMS action.",
  },
}

/** Order the groups appear in on the Fix issues step. */
export const GROUP_ORDER: GroupKey[] = ['fix', 'check', 'missing', 'notInBooks', 'confirm2b']

export function groupOf(r: Classifiable): GroupKey | null {
  if (r.rule === '2B-first') return 'confirm2b'
  if (r.rule === 'Added by staff') return null
  if (r.risks.length || r.rule === RULES.duplicate || r.rule === RULES.rcm) return 'fix'
  if (r.status === 'probable') return 'check'
  if (r.status === 'only_in_register') return 'missing'
  if (r.status === 'only_in_2b') return 'notInBooks'
  return null
}

export function needsAction(r: Classifiable): boolean {
  const g = groupOf(r)
  if (!g) return false
  return g === 'confirm2b' ? !r.mark : !r.decision
}

export const openCount = (rows: Classifiable[]) => rows.filter(needsAction).length

export function optionsFor(r: Classifiable): Option[] {
  switch (groupOf(r)) {
    case 'fix': {
      const type = r.rule === RULES.duplicate ? 'Duplicate' : r.rule === RULES.rcm ? 'RCM' : r.risks[0]?.type
      if (type === 'Duplicate') return [{ label: 'Remove duplicate', decision: 'Remove from register', help: 'Drops this copy so the ITC is not claimed twice' }]
      if (type === 'RCM') return [{ label: 'Will pay under RCM', decision: 'Pay under RCM', help: 'Pay this tax in GSTR-3B, then claim it back as ITC' }]
      if (type === 'Cancelled GSTIN') return [{ label: "Don't claim", decision: "Don't claim", help: "Supplier's registration was cancelled before this invoice" }]
      if (type === 'Blocked 17(5)') {
        return r.b2b
          ? [{ label: "Accept in IMS, don't claim", decision: 'Blocked: not claimed', ims: 'Accept', help: 'The invoice is genuine but this credit is blocked under 17(5)' }]
          : [{ label: "Don't claim", decision: 'Blocked: not claimed', help: 'This credit is blocked under 17(5)' }]
      }
      return [{ label: 'Ask supplier to correct', decision: 'Ask supplier to correct', help: 'Supplier should amend the tax type on this invoice' }]
    }
    case 'check':
      return [
        { label: 'Same invoice', decision: 'Confirmed match', ims: 'Accept', help: 'Counts it as matched and accepts it in IMS' },
        { label: 'Different invoices', decision: 'Not a match', ims: 'Pending', help: 'Keeps it pending in IMS' },
      ]
    case 'missing':
      return [
        { label: 'Chase supplier', decision: 'Chase supplier', help: 'Adds it to the supplier messages in step 3' },
        { label: 'Wait till next month', decision: 'Claim next period', help: "Checks again in next month's GSTR-2B" },
        { label: 'Wrong entry', decision: 'Remove from register', help: 'Drops it; not carried to next month' },
      ]
    case 'notInBooks':
      return [
        { label: 'Client has it', decision: 'Add to register', ims: 'Accept', help: 'Accepts it in IMS; add it to the books' },
        { label: 'Ask client', decision: 'Ask client', ims: 'Pending', help: 'Keeps it pending in IMS until the client confirms' },
        { label: 'Not ours', decision: 'Reject in IMS', ims: 'Reject', help: 'Rejects it in IMS so the credit is not counted' },
      ]
    default:
      return []
  }
}

/** Decisions that take an invoice off the supplier-message list. */
export const NO_FOLLOW_UP = new Set(['Claim next period', 'Remove from register', "Don't claim", 'Blocked: not claimed', 'Pay under RCM'])
