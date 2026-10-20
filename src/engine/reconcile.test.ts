import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDate } from './format'
import { autoMap, b2bFromJson, registerDocs, sheetFromWorkbook, suppliersFromSheet, workbookFromBuffer } from './parse'
import { carriesForward, invLoose, invStrict, reconcile, RULES, summarize } from './reconcile'
import type { RunInput, Supplier } from './types'

const samples = resolve(__dirname, '../../public/samples')
const sheet = (name: string) => sheetFromWorkbook(workbookFromBuffer(readFileSync(resolve(samples, name)), name), name)

function sampleInput(): RunInput {
  const reg = sheet('purchase_register_sep2026.csv')
  const cf = sheet('carry_forward_aug2026.csv')
  const b2b = b2bFromJson(readFileSync(resolve(samples, 'gstr2b_sep2026.json'), 'utf8'))
  const master = new Map<string, Supplier>(suppliersFromSheet(sheet('supplier_master.csv')).map(s => [s.gstin, s]))
  return {
    register: registerDocs(reg, autoMap(reg.headers)),
    carryForward: registerDocs(cf, autoMap(cf.headers), 'carry_forward'),
    b2b: b2b.docs, filed: b2b.filed, master, clientGstin: b2b.clientGstin!,
  }
}

describe('invoice number cleanup', () => {
  it('ignores case and separators', () => expect(invStrict('dss/26-27/0412')).toBe('DSS26270412'))
  it('drops leading zeros per part', () => expect(invLoose('SGP-0457')).toBe(invLoose('SGP/457')))
  it('keeps a lone zero', () => expect(invLoose('A-0')).toBe('A0'))
})

describe('dates', () => {
  it('reads common formats', () => {
    expect(parseDate('04-09-2026')).toBe('2026-09-04')
    expect(parseDate('4/9/26')).toBe('2026-09-04')
    expect(parseDate('4-Sep-26')).toBe('2026-09-04')
    expect(parseDate('2026-09-04')).toBe('2026-09-04')
  })
})

describe('column mapping', () => {
  it('maps Tally headers', () => {
    const reg = sheet('purchase_register_sep2026.csv')
    const map = autoMap(reg.headers)
    expect(reg.headers[map.gstin]).toBe('GSTIN/UIN')
    expect(reg.headers[map.invoice]).toBe('Vch No.')
    expect(reg.headers[map.date]).toBe('Date')
    expect(reg.headers[map.rcm]).toBe('Reverse Charge')
  })
})

describe('reconciliation on the sample files', () => {
  const input = sampleInput()
  const results = reconcile(input)
  const s = summarize(results, input)
  const find = (inv: string, rule?: string) => results.find(x => (x.reg?.invoice ?? x.b2b?.invoice) === inv && (!rule || x.rule === rule))!

  it('reads dd-mm-yyyy dates in CSV correctly', () => {
    expect(input.register[0].date).toBe('2026-09-04')
    expect(input.master.get('29AAMFG5567N1ZD')?.cancelled_on).toBe('2026-08-10')
  })

  it('reads every row', () => {
    expect(input.register).toHaveLength(11)
    expect(input.carryForward).toHaveLength(1)
    expect(input.b2b).toHaveLength(9)
  })

  it('gives the same counts as the Python engine', () => {
    expect(s.counts).toEqual({ matched: 4, probable: 2, only_in_register: 6, only_in_2b: 3 })
    expect(Math.round(s.itcSafe)).toBe(40662)
    expect(Math.round(s.itcReview)).toBe(15966)
    expect(Math.round(s.itcAtRisk)).toBe(28789)
    expect(s.ims).toEqual({ Accept: 6, Reject: 1, Pending: 2 })
    expect(s.suppliersToChase).toBe(3)
  })

  it('applies each rule to the right invoice', () => {
    expect(find('CC/2026/339').reason).toContain('matched across periods')
    expect(find('SGP-0457').rule).toBe(RULES.format)
    expect(find('MPM-7781').rule).toBe(RULES.value)
    expect(find('KL-889').rule).toBe(RULES.rcm)
    expect(find('INV-2318', RULES.duplicate)).toBeTruthy()
    expect(find('GLA/092').risks.map(r => r.type)).toContain('Cancelled GSTIN')
    expect(find('AE/889').ims).toBe('Reject')
    expect(find('RC-301').risks.map(r => r.type)).toContain('Blocked 17(5)')
  })

  it('carries forward only claimable unmatched rows', () => {
    expect(results.filter(carriesForward).map(x => x.reg!.invoice).sort()).toEqual(['ST-1450', 'VH-2291', 'VH-2304'])
  })
})
