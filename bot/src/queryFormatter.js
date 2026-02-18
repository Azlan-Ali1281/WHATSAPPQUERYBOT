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

function formatQueryForVendor(data) {
  // 🛡️ DATABASE MAPPING
  // We now extract the IDs directly from the object sent by index.js
  const q = data.parsed;
  const clientCode = data.clientCode || 'REQ';
  const dbId = data.id || '0';

  const lines = [];

  // 1️⃣ REFERENCE LINE (Top Priority)
  // This will now show: Ref: *HBA-10*

  // 2️⃣ HOTEL NAME
  lines.push(q.hotel.toUpperCase())

  // 3️⃣ DATE RANGE
  if (q.dateLabel) {
    lines.push(q.dateLabel.toUpperCase())
  } else {
    const dateLine = formatDateRange(q.check_in, q.check_out)
    if (dateLine) lines.push(dateLine)
  }

  // 4️⃣ ROOM LINE
  const roomPrefix = (q.rooms && q.rooms > 1) ? `${q.rooms} ` : ''
  lines.push(`${roomPrefix}${(q.room_type || 'DOUBLE').toUpperCase()}`)

  // 5️⃣ MEAL (Show everything except RO)
  if (q.meal && q.meal !== 'RO') {
    lines.push(q.meal.toUpperCase())
  }

  // 6️⃣ VIEW (Show everything except CITY)
  if (q.view && !/CITY/i.test(q.view)) {
    lines.push(q.view.toUpperCase())
  }

  
  lines.push(''); // Gap
  lines.push(`Ref: *${clientCode}*`);

  return lines.join('\n')
}

module.exports = { formatQueryForVendor }
