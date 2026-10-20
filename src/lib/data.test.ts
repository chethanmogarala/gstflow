// Data-layer flows against the in-memory demo database.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeSupabase } from './fakeSupabase'

const fake = createFakeSupabase()
vi.mock('./supabase', () => ({ db: () => fake, supabase: fake, isDemo: true }))

const { addManualInvoice, ensurePeriod, loadCarryForward, loadRows, run2bFirst, runReconciliation, updateResult } = await import('./data')
const { autoMap, b2bFromJson, registerDocs, savedFromMap, sheetFromWorkbook, workbookFromBuffer } = await import('../engine/parse')
const { openCount } = await import('./todo')

const samples = resolve(__dirname, '../../public/samples')
const sheet = (name: string) => sheetFromWorkbook(workbookFromBuffer(readFileSync(resolve(samples, name)), name), name)
const b2b = () => b2bFromJson(readFileSync(resolve(samples, 'gstr2b_sep2026.json'), 'utf8'))

async function newClient(gstin: string) {
  const { data: firmId } = await fake.rpc('create_firm', { firm_name: 'Test firm' })
  const { data } = await fake.from('clients').insert({ firm_id: firmId, name: 'Test client', gstin }).select().single()
  return data
}

describe('register upload and carry-forward', () => {
  it('runs, saves, and carries unmatched invoices into next month', async () => {
    const client = await newClient('29AAKFS4821M1ZQ')
    const sep = await ensurePeriod(client, '092026')
    expect((await ensurePeriod(client, '092026')).id).toBe(sep.id)

    const reg = sheet('purchase_register_sep2026.csv')
    const map = autoMap(reg.headers)
    const s = await runReconciliation({
      client, period: sep, email: 't@test', register: registerDocs(reg, map), b2b: b2b(),
      registerFile: 'r.csv', b2bFile: 'b.json', columnMap: savedFromMap(reg.headers, map), carryForward: [],
    })
    expect(s.counts.matched).toBe(3)
    const rows = await loadRows(sep.id)
    // 11 register rows + Coastal Chemicals' 2B record, which has no August row to match here.
    expect(rows).toHaveLength(15)
    expect(openCount(rows)).toBe(s.open)

    // "Wrong entry" on one missing invoice keeps it out of October.
    const st = rows.find(r => r.reg?.invoice === 'ST-1450')!
    await updateResult(st.id, { decision: 'Remove from register' })
    const carried = await loadCarryForward(client, '102026')
    // No supplier list in this test, so Green Leaf is not known to be cancelled and carries too.
    expect(carried.map(d => d.invoice).sort()).toEqual(['GLA/092', 'VH-2291', 'VH-2304'])
    expect(carried.every(d => d.source === 'carry_forward')).toBe(true)

    const { data: saved } = await fake.from('clients').select('*').eq('id', client.id).single()
    expect((saved as { column_map: Record<string, string> }).column_map.gstin).toBe('GSTIN/UIN')
  })
})

describe('no purchase register (2B-first)', () => {
  it('lists every 2B invoice to confirm and accepts invoices added by staff', async () => {
    const client = await newClient('29ABQPB7310R1Z6')
    const sep = await ensurePeriod(client, '092026')
    await run2bFirst({ client, period: sep, email: 't@test', b2b: b2b(), b2bFile: 'b.json' })
    let rows = await loadRows(sep.id)
    expect(rows).toHaveLength(9)
    expect(openCount(rows)).toBe(9)

    await updateResult(rows[0].id, { mark: 'have', ims_final: 'Accept' })
    await addManualInvoice(client, sep, 't@test', {
      supplier: 'Local Supplier', gstin: '29AAAAA0000A1Z5', invoice: 'LS-1', date: '2026-09-10',
      taxable: 1000, igst: 0, cgst: 90, sgst: 90, tax: 180, rcm: false, ledger: '',
    })
    rows = await loadRows(sep.id)
    expect(rows).toHaveLength(10)
    expect(openCount(rows)).toBe(8)
    expect(rows.find(r => r.rule === 'Added by staff')?.reg?.tax).toBe(180)

    const { data: p } = await fake.from('periods').select('*').eq('id', sep.id).single()
    expect((p as { register_file: string | null }).register_file).toBeNull()
  })
})
