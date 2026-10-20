// "Try it with sample data": a ready-made client with September 2026 reconciled.
import { autoMap, b2bFromJson, registerDocs, savedFromMap, sheetFromWorkbook, suppliersFromSheet, workbookFromBuffer } from '../engine/parse'
import { audit, ensurePeriod, runReconciliation } from './data'
import { db } from './supabase'
import type { Client, Firm } from './types'

export const SAMPLE = { name: 'Sri Lakshmi Traders (sample)', gstin: '29AAKFS4821M1ZQ', period: '092026' }

async function fetchSample(name: string) {
  const res = await fetch(`${import.meta.env.BASE_URL}samples/${name}`)
  if (!res.ok) throw new Error(`Could not load sample file ${name}`)
  return new Uint8Array(await res.arrayBuffer())
}

export async function loadSample(firm: Firm, email: string): Promise<Client> {
  const existing = await db().from('clients').select('*').eq('firm_id', firm.id).eq('gstin', SAMPLE.gstin).maybeSingle()
  if (existing.data) return existing.data
  const { data: client, error } = await db().from('clients').insert({ firm_id: firm.id, name: SAMPLE.name, gstin: SAMPLE.gstin }).select().single()
  if (error) throw error

  const sheet = async (name: string) => sheetFromWorkbook(workbookFromBuffer(await fetchSample(name), name), name)
  const [reg, cf, master] = await Promise.all([sheet('purchase_register_sep2026.csv'), sheet('carry_forward_aug2026.csv'), sheet('supplier_master.csv')])
  const b2b = b2bFromJson(new TextDecoder().decode(await fetchSample('gstr2b_sep2026.json')))

  await db().from('suppliers').upsert(suppliersFromSheet(master).map(s => ({ ...s, firm_id: firm.id, client_id: client.id })), { onConflict: 'client_id,gstin' })
  const period = await ensurePeriod(client, SAMPLE.period)
  const map = autoMap(reg.headers)
  await runReconciliation({
    client, period, email, register: registerDocs(reg, map), b2b,
    registerFile: 'purchase_register_sep2026.csv', b2bFile: 'gstr2b_sep2026.json',
    columnMap: savedFromMap(reg.headers, map), carryForward: registerDocs(cf, autoMap(cf.headers), 'carry_forward'),
  })
  await audit(firm.id, client.id, period.id, email, 'Loaded sample data', 'Made-up client and invoices for trying GSTFlow')
  return client
}
