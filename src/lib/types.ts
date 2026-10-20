import type { Doc, ImsAction, Risk, Status } from '../engine/types'

export type Mode = 'register' | '2b_first'
export type Mark = 'have' | 'ask' | 'not'

export interface Firm { id: string; name: string }
export interface Member { firm_id: string; user_id: string; email: string; role: 'admin' | 'staff' }

export interface Client {
  id: string
  firm_id: string
  name: string
  gstin: string
  mode: Mode
  column_map: Record<string, string> | null
  created_at: string
}

export interface Period {
  id: string
  firm_id: string
  client_id: string
  period: string
  status: 'draft' | 'in_review' | 'final'
  register_file: string | null
  b2b_file: string | null
  run_at: string | null
  summary: Record<string, unknown> | null
  created_at: string
}

export interface DocRow {
  id: string
  side: 'register' | '2b'
  source: Doc['source']
  line: number | null
  supplier: string | null
  gstin: string
  invoice: string
  inv_date: string | null
  taxable: number
  igst: number
  cgst: number
  sgst: number
  rcm: boolean
  ledger: string | null
}

export interface ResultRow {
  id: string
  period_id: string
  reg_doc: string | null
  b2b_doc: string | null
  status: Status
  rule: string
  reason: string
  risks: Risk[]
  ims_suggested: ImsAction | null
  ims_why: string | null
  ims_final: ImsAction | null
  mark: Mark | null
  decision: string | null
  note: string | null
  decided_by: string | null
  decided_at: string | null
}

/** A result joined with its documents, as the workspace uses it. */
export interface Row extends ResultRow {
  reg: Doc | null
  b2b: Doc | null
  supplier: string
  gstin: string
}

export interface AuditEntry {
  id: number
  user_email: string | null
  action: string
  detail: string | null
  at: string
}
