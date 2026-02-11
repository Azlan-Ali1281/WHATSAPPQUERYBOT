const { getClientCode } = require('./groupConfig')
const { getParent } = require('./queryStore')

const MONTHS = {
  '01': 'JAN', '02': 'FEB', '03': 'MAR', '04': 'APR',
  '05': 'MAY', '06': 'JUN', '07': 'JUL', '08': 'AUG',
  '09': 'SEP', '10': 'OCT', '11': 'NOV', '12': 'DEC'
}

function formatDateRange(checkIn, checkOut) {
  if (!checkIn || !checkOut) return ''
  const [ , m1, d1 ] = checkIn.split('-')
  const [ , m2, d2 ] = checkOut.split('-')

  const day1 = parseInt(d1, 10)
  const day2 = parseInt(d2, 10)
  const month1 = MONTHS[m1] || ''
  const month2 = MONTHS[m2] || ''

  return (m1 === m2) ? `${day1}-${day2} ${month1}` : `${day1} ${month1} - ${day2} ${month2}`
}

function formatQueryForVendor(child) {
  const q = child.parsed
  const parent = getParent(child.parentId)
  const clientGroupId = parent?.clientGroupId
  const clientCode = getClientCode(clientGroupId)

  const lines = []

  // 1️⃣ HOTEL NAME
  lines.push(q.hotel)

  // 2️⃣ DATE RANGE
  const dateLine = formatDateRange(q.check_in, q.check_out)
  if (dateLine) lines.push(dateLine)

  // 3️⃣ ROOM LINE (Logic: 2 QUAD vs QUAD)
  const roomPrefix = (q.rooms && q.rooms > 1) ? `${q.rooms} ` : ''
  lines.push(`${roomPrefix}${q.room_type || 'DOUBLE'}`)

  // 4️⃣ MEAL (SKIP RO)
  if (q.meal && q.meal !== 'RO') {
    lines.push(q.meal)
  }

  // 5️⃣ VIEW (SKIP CITY)
  if (q.view && !/CITY/i.test(q.view)) {
    lines.push(q.view)
  }

  // 6️⃣ BLANK LINE + CLIENT CODE
  lines.push('')
  lines.push(`ref#${clientCode}`)

  return lines.join('\n')
}

module.exports = { formatQueryForVendor }