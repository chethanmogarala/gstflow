// In-memory stand-in for Supabase, used only in demo mode (vite --mode demo).
// Supports the query shapes this app uses; data lives in this browser tab and is lost on reload.
import type { SupabaseClient } from '@supabase/supabase-js'

type Rec = Record<string, unknown>
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null }

const now = () => new Date().toISOString()
const USER = { id: 'demo-user', email: 'demo@gstflow.test' }

const tables: Record<string, Rec[]> = {
  firms: [], firm_members: [], firm_invites: [], clients: [], suppliers: [],
  periods: [], documents: [], results: [], audit_log: [],
}
let auditSeq = 1

const DEFAULTS: Record<string, () => Rec> = {
  firms: () => ({ created_at: now() }),
  firm_members: () => ({ created_at: now(), role: 'staff' }),
  firm_invites: () => ({ created_at: now(), role: 'staff' }),
  clients: () => ({ mode: 'register', column_map: null, created_at: now() }),
  suppliers: () => ({ name: null, registration_status: 'Active', cancelled_on: null, category: null }),
  periods: () => ({ status: 'draft', register_file: null, b2b_file: null, run_at: null, summary: null, created_at: now() }),
  documents: () => ({ line: null, supplier: null, inv_date: null, taxable: 0, igst: 0, cgst: 0, sgst: 0, rcm: false, ledger: null }),
  results: () => ({ reg_doc: null, b2b_doc: null, risks: [], ims_suggested: null, ims_why: null, ims_final: null, mark: null, decision: null, note: null, decided_by: null, decided_at: null }),
  audit_log: () => ({ client_id: null, period_id: null, user_id: USER.id, user_email: null, detail: null, at: now() }),
}
const UNIQUE: Record<string, string[]> = { clients: ['firm_id', 'gstin'], periods: ['client_id', 'period'], suppliers: ['client_id', 'gstin'], firm_invites: ['firm_id', 'email'] }

const clone = <T,>(v: T): T => structuredClone(v)

function cascade(table: string, removed: Rec[]) {
  const ids = new Set(removed.map(r => r.id))
  const drop = (t: string, test: (r: Rec) => boolean) => {
    const gone = tables[t].filter(test)
    tables[t] = tables[t].filter(r => !test(r))
    cascade(t, gone)
  }
  if (table === 'clients') { drop('periods', r => ids.has(r.client_id)); drop('suppliers', r => ids.has(r.client_id)); drop('audit_log', r => ids.has(r.client_id)) }
  if (table === 'periods') { drop('documents', r => ids.has(r.period_id)); drop('results', r => ids.has(r.period_id)); drop('audit_log', r => ids.has(r.period_id)) }
  if (table === 'documents') drop('results', r => ids.has(r.reg_doc) || ids.has(r.b2b_doc))
}

class Query implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select'
  private filters: ((r: Rec) => boolean)[] = []
  private payload: Rec[] | Rec = []
  private conflict: string[] = []
  private sort: { col: string; asc: boolean } | null = null
  private from = 0
  private to = Infinity
  private one: 'single' | 'maybe' | null = null
  private returning = false
  private embedFirm = false
  private countOnly = false

  private table: string
  constructor(table: string) { this.table = table }

  select(cols = '*', opts?: { count?: string; head?: boolean }) {
    if (this.op !== 'select') this.returning = true
    this.embedFirm = cols.includes('firms(')
    this.countOnly = !!opts?.head
    return this
  }
  insert(v: Rec | Rec[]) { this.op = 'insert'; this.payload = Array.isArray(v) ? v : [v]; return this }
  upsert(v: Rec | Rec[], opts?: { onConflict?: string }) { this.op = 'upsert'; this.payload = Array.isArray(v) ? v : [v]; this.conflict = opts?.onConflict?.split(',') ?? ['id']; return this }
  update(p: Rec) { this.op = 'update'; this.payload = p; return this }
  delete() { this.op = 'delete'; return this }
  eq(c: string, v: unknown) { this.filters.push(r => r[c] === v); return this }
  in(c: string, vs: unknown[]) { const s = new Set(vs); this.filters.push(r => s.has(r[c])); return this }
  order(col: string, o?: { ascending?: boolean }) { this.sort = { col, asc: o?.ascending !== false }; return this }
  range(a: number, b: number) { this.from = a; this.to = b; return this }
  limit(n: number) { this.to = this.from + n - 1; return this }
  single() { this.one = 'single'; return this }
  maybeSingle() { this.one = 'maybe'; return this }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve().then(() => this.run()).then(ok, bad)
  }

  private match = (r: Rec) => this.filters.every(f => f(r))

  private dupe(row: Rec): boolean {
    const keys = UNIQUE[this.table]
    return !!keys && tables[this.table].some(r => r !== row && keys.every(k => r[k] === row[k]))
  }

  private run(): Result {
    const t = tables[this.table]
    let out: Rec[] = []
    if (this.op === 'select') {
      out = t.filter(this.match)
      if (this.sort) { const { col, asc } = this.sort; out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1)) }
      if (this.countOnly) return { data: null, error: null, count: out.length }
      out = out.slice(this.from, this.to + 1)
      if (this.embedFirm) out = out.map(r => ({ ...r, firms: tables.firms.find(f => f.id === r.firm_id) ?? null }))
    } else if (this.op === 'insert' || this.op === 'upsert') {
      for (const p of this.payload as Rec[]) {
        if (this.op === 'upsert') {
          const existing = t.find(r => this.conflict.every(k => r[k] === p[k]))
          if (existing) { Object.assign(existing, clone(p)); out.push(existing); continue }
        }
        const row: Rec = { ...DEFAULTS[this.table]?.(), ...clone(p), id: this.table === 'audit_log' ? auditSeq++ : crypto.randomUUID() }
        if (this.dupe(row)) return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } }
        t.push(row)
        out.push(row)
      }
    } else if (this.op === 'update') {
      out = t.filter(this.match)
      out.forEach(r => Object.assign(r, clone(this.payload as Rec)))
    } else {
      out = t.filter(this.match)
      tables[this.table] = t.filter(r => !this.match(r))
      cascade(this.table, out)
    }
    if (this.op !== 'select' && !this.returning) return { data: null, error: null }
    if (this.one) {
      if (!out.length) return this.one === 'maybe' ? { data: null, error: null } : { data: null, error: { message: 'No rows found' } }
      return { data: clone(out[0]), error: null }
    }
    return { data: clone(out), error: null }
  }
}

type Listener = (event: string, session: unknown) => void

export function createFakeSupabase(): SupabaseClient {
  const listeners = new Set<Listener>()
  const session = { user: USER, access_token: 'demo' }
  const fake = {
    from: (table: string) => new Query(table),
    rpc: async (fn: string, args: Rec) => {
      if (fn === 'create_firm') {
        const id = crypto.randomUUID()
        tables.firms.push({ id, name: args.firm_name, created_at: now() })
        tables.firm_members.push({ firm_id: id, user_id: USER.id, email: USER.email, role: 'admin', created_at: now() })
        return { data: id, error: null }
      }
      return { data: 0, error: null }
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: (cb: Listener) => { listeners.add(cb); return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } } },
      signInWithPassword: async () => { listeners.forEach(l => l('SIGNED_IN', session)); return { data: { session }, error: null } },
      signUp: async () => ({ data: { session }, error: null }),
      signOut: async () => { listeners.forEach(l => l('SIGNED_OUT', null)); return { error: null } },
    },
  }
  return fake as unknown as SupabaseClient
}
