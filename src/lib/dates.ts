/**
 * All business dates are in Philippine time (UTC+8, no DST), regardless of where the server runs.
 * Calendar days are stored as 'yyyy-MM-dd' strings; instants as Date.
 */
export const TZ = 'Asia/Manila'
const OFFSET_MS = 8 * 60 * 60 * 1000

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })

/** 'yyyy-MM-dd' of an instant, in Manila. */
export function manilaDate(d: Date = new Date()) {
  return dayFmt.format(d)
}

/** Minutes since local midnight in Manila. */
export function manilaMinutes(d: Date) {
  const local = new Date(d.getTime() + OFFSET_MS)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

/** The instant for a Manila wall-clock time on a calendar day. */
export function manilaInstant(day: string, hours: number, minutes: number) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hours, minutes) - OFFSET_MS)
}

/** Pure calendar arithmetic on 'yyyy-MM-dd'. */
export function addDays(day: string, n: number) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

export function isWeekend(day: string) {
  const [y, m, d] = day.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return dow === 0 || dow === 6
}

export function eachDay(start: string, end: string) {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  return out
}

export function lastDayOfMonth(year: number, month1: number) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate()
}

/** The semi-monthly cut-off (1–15 or 16–end) that contains a calendar day. */
export function cutoffFor(day: string) {
  const [y, m, d] = day.split('-').map(Number)
  const mm = String(m).padStart(2, '0')
  return d <= 15
    ? { start: `${y}-${mm}-01`, end: `${y}-${mm}-15` }
    : { start: `${y}-${mm}-16`, end: `${y}-${mm}-${String(lastDayOfMonth(y, m)).padStart(2, '0')}` }
}

const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "Oct 1 – 15, 2026" */
export function periodLabel(start: string, end: string) {
  const s = new Date(`${start}T00:00:00Z`)
  return `${short.format(s)} – ${Number(end.slice(8))}, ${end.slice(0, 4)}`
}
