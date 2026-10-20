import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { currentReturnPeriod, dueDate, nextPeriod } from '../engine/format'
import { autoMap, b2bFromJson, registerDocs, sheetFromWorkbook, suppliersFromSheet, workbookFromBuffer } from '../engine/parse'
import { reconcile } from '../engine/reconcile'
import type { Supplier } from '../engine/types'
import { groupOf, needsAction, openCount, optionsFor } from './todo'

const samples = resolve(__dirname, '../../public/samples')
const sheet = (name: string) => sheetFromWorkbook(workbookFromBuffer(readFileSync(resolve(samples, name)), name), name)

function sampleResults() {
  const reg = sheet('purchase_register_sep2026.csv')
  const cf = sheet('carry_forward_aug2026.csv')
  const b2b = b2bFromJson(readFileSync(resolve(samples, 'gstr2b_sep2026.json'), 'utf8'))
  const master = new Map<string, Supplier>(suppliersFromSheet(sheet('supplier_master.csv')).map(s => [s.gstin, s]))
  return reconcile({
    register: registerDocs(reg, autoMap(reg.headers)), carryForward: registerDocs(cf, autoMap(cf.headers), 'carry_forward'),
    b2b: b2b.docs, filed: b2b.filed, master, clientGstin: b2b.clientGstin!,
  })
}

describe('to-do groups on the sample files', () => {
  const results = sampleResults()
  const inv = (r: (typeof results)[number]) => r.reg?.invoice ?? r.b2b?.invoice
  const group = (g: string) => results.filter(r => groupOf(r) === g).map(inv).sort()

  it('puts every non-matched invoice in exactly one group', () => {
    expect(group('fix')).toEqual(['GLA/092', 'INV-2318', 'KL-889', 'RC-301'])
    expect(group('check')).toEqual(['MPM-7781', 'SGP-0457'])
    expect(group('missing')).toEqual(['ST-1450', 'VH-2291', 'VH-2304'])
    expect(group('notInBooks')).toEqual(['AE/889', 'MOM-5512'])
    expect(openCount(results)).toBe(11)
  })

  it('a decision closes the item', () => {
    const r = results.find(x => groupOf(x) === 'check')!
    expect(needsAction({ ...r, decision: 'Confirmed match' })).toBe(false)
  })

  it('options set the IMS action where it applies', () => {
    const notInBooks = results.find(x => groupOf(x) === 'notInBooks')!
    expect(optionsFor(notInBooks).map(o => o.ims)).toEqual(['Accept', 'Pending', 'Reject'])
    const blocked = results.find(x => inv(x) === 'RC-301')!
    expect(optionsFor(blocked)[0].ims).toBe('Accept')
  })
})

describe('return period dates', () => {
  it('works on last month', () => expect(currentReturnPeriod(new Date(2026, 9, 20))).toBe('092026'))
  it('rolls over the year', () => expect(nextPeriod('122026')).toBe('012027'))
  it('GSTR-3B is due on the 20th of next month', () => expect(dueDate('092026')).toBe('20 Oct 2026'))
})
