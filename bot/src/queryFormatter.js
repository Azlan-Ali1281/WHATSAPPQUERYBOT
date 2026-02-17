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
  
  // Use map to get month name, fallback to number if missing
  const month1 = MONTHS[m1] || m1
  const month2 = MONTHS[m2] || m2

  // Format: "19-20 FEB" or "28 FEB - 02 MAR"
  return (m1 === m2) ? `${day1}-${day2} ${month1}` : `${day1} ${month1} - ${day2} ${month2}`
}

function formatQueryForVendor(child) {
  const q = child.parsed
  const parent = getParent(child.parentId)
  const clientGroupId = parent?.clientGroupId
  // Use a fallback code if clientCode is missing
  const clientCode = getClientCode(clientGroupId) || 'UNKNOWN'

  const lines = []

  // 1️⃣ HOTEL NAME
  // Converts "EMAAR AL MANAR" -> "EMAAR AL MANAR" (Upper Case Preferred)
  lines.push(q.hotel.toUpperCase())

  // 2️⃣ DATE RANGE (WITH SPECIAL LABEL SUPPORT)
  // If we have a special label like "LAST ASHRA", use it.
  if (q.dateLabel) {
    lines.push(q.dateLabel.toUpperCase())
  } else {
    // Otherwise use standard date formatting (e.g. 19-20 FEB)
    const dateLine = formatDateRange(q.check_in, q.check_out)
    if (dateLine) lines.push(dateLine)
  }

  // 3️⃣ ROOM LINE (Logic: 2 QUAD vs QUAD)
  // If rooms > 1, prefix the count (e.g. "2 TRIPLE"). Else just "TRIPLE"
  const roomPrefix = (q.rooms && q.rooms > 1) ? `${q.rooms} ` : ''
  lines.push(`${roomPrefix}${(q.room_type || 'DOUBLE').toUpperCase()}`)

  // 4️⃣ MEAL (SKIP RO)
  // Only show meal if it's NOT Room Only
  if (q.meal && q.meal !== 'RO') {
    lines.push(q.meal.toUpperCase())
  }

  // 5️⃣ VIEW (SKIP CITY)
  // Only show view if it's NOT City View
  if (q.view && !/CITY/i.test(q.view)) {
    lines.push(q.view.toUpperCase())
  }

  // 6️⃣ BLANK LINE + CLIENT CODE
  lines.push('')
  lines.push(`ref#${clientCode}`)

  return lines.join('\n')
}

module.exports = { formatQueryForVendor }