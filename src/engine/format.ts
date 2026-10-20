/** ₹1,25,000 style rupee formatting. Paise are shown only when present. */
export function inr(amount: number): string {
  const rounded = Math.round(amount * 100) / 100
  const hasPaise = Math.abs(rounded % 1) > 0.001
  return '₹' + rounded.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  })
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** ISO date -> dd-mm-yyyy, the format GST documents use. */
export function dmy(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}-${m}-${y}`
}

/** 'MMYYYY' -> 'September 2026' */
export function periodLabel(period: string): string {
  return `${MONTHS_LONG[Number(period.slice(0, 2)) - 1]} ${period.slice(2)}`
}

/** 'MMYYYY' -> 'Sep 2026' */
export function periodShort(period: string): string {
  return `${MONTHS[Number(period.slice(0, 2)) - 1]} ${period.slice(2)}`
}

/** The return period before 'MMYYYY'. */
export function previousPeriod(period: string): string {
  let m = Number(period.slice(0, 2)) - 1
  let y = Number(period.slice(2))
  if (m === 0) { m = 12; y -= 1 }
  return String(m).padStart(2, '0') + y
}

const MONTH_INDEX: Record<string, number> = Object.fromEntries(MONTHS.map((m, i) => [m.toLowerCase(), i + 1]))

/** Reads the date formats found in Tally, Excel and portal exports. Returns ISO or null. */
export function parseDate(value: unknown): string | null {
  if (value == null || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // SheetJS gives local-midnight dates; read the local parts so the day doesn't shift.
    return iso(value.getFullYear(), value.getMonth() + 1, value.getDate())
  }
  if (typeof value === 'number' && value > 20000 && value < 80000) {
    // Excel serial date.
    const d = new Date(Date.UTC(1899, 11, 30) + value * 86400000)
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
  }
  const s = String(value).trim()
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (m) return iso(year(m[3]), Number(m[2]), Number(m[1]))
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]))
  m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3})[A-Za-z]*[-\s/,]+(\d{2,4})$/)
  if (m && MONTH_INDEX[m[2].toLowerCase()]) return iso(year(m[3]), MONTH_INDEX[m[2].toLowerCase()], Number(m[1]))
  return null
}

function year(y: string): number {
  const n = Number(y)
  return y.length === 2 ? 2000 + n : n
}

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function toNum(value: unknown): number {
  if (typeof value === 'number') return value
  const s = String(value ?? '').replace(/[,₹\s]/g, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}
