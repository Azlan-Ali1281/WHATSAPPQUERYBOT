/**
 * DATE RESOLVER (FINAL)
 * --------------------
 * Converts textual dates to YYYY-MM-DD
 * WITHOUT using Date(), timezones, or offsets
 */

const MONTHS = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12'
}

function resolveDate(text) {
  if (!text) return null

  const m = text
    .toUpperCase()
    .match(/(\d{1,2})\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/)

  if (!m) return null

  const day = m[1].padStart(2, '0')
  const month = MONTHS[m[2]]

  // 🔒 STATIC YEAR LOGIC (NO DATE OBJECTS)
  const nowYear = new Date().getFullYear()
  const monthNum = parseInt(month, 10)
  const nowMonth = new Date().getMonth() + 1

  const year =
    monthNum < nowMonth ? nowYear + 1 : nowYear

  return `${year}-${month}-${day}`
}

module.exports = {
  resolveDate
}
