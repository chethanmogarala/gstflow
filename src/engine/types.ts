export type Side = 'register' | '2b'
export type Source = 'register' | 'carry_forward' | '2b' | 'manual'
export type Status = 'matched' | 'probable' | 'only_in_register' | 'only_in_2b'
export type ImsAction = 'Accept' | 'Reject' | 'Pending'

/** One purchase invoice, from either the register or GSTR-2B. Dates are ISO (yyyy-mm-dd). */
export interface Doc {
  key: string
  side: Side
  source: Source
  line?: number
  supplier: string
  gstin: string
  invoice: string
  date: string | null
  taxable: number
  igst: number
  cgst: number
  sgst: number
  tax: number
  rcm: boolean
  ledger: string
}

export interface Supplier {
  gstin: string
  name?: string | null
  registration_status: string
  cancelled_on: string | null
  category?: string | null
}

export interface Risk {
  type: string
  note: string
}

export interface Result {
  reg: Doc | null
  b2b: Doc | null
  status: Status
  rule: string
  reason: string
  risks: Risk[]
  ims: ImsAction | null
  imsWhy: string
  supplier: string
  gstin: string
}

export interface RunInput {
  register: Doc[]
  carryForward: Doc[]
  b2b: Doc[]
  /** GSTINs of suppliers who filed GSTR-1 for the period (from 2B). */
  filed: Set<string>
  master: Map<string, Supplier>
  clientGstin: string
}

export interface Summary {
  registerRows: number
  carriedForward: number
  b2bRecords: number
  counts: Record<Status, number>
  byRule: Record<string, number>
  itcSafe: number
  itcReview: number
  itcAtRisk: number
  ims: Record<ImsAction, number>
  suppliersToChase: number
}
