const { resolveDate } = require('./dateResolver')

function detectView(text) {
  if (/PARTIAL\s*KAABA/i.test(text)) return 'PARTIAL KAABA VIEW'
  if (/KAABA\s*VIEW/i.test(text)) return 'KAABA VIEW'
  if (/HARAM\s*VIEW/i.test(text)) return 'HARAM VIEW'
  if (/CITY\s*VIEW/i.test(text)) return 'CITY VIEW'
  return null
}

function roomTypeFromPersons(persons) {
  if (!persons) return null
  if (persons <= 2) return 'DOUBLE'
  if (persons === 3) return 'TRIPLE'
  if (persons === 4) return 'QUAD'
  if (persons === 5) return 'QUINT'
  if (persons >= 6) return `${persons} PAX SUITE`
  return null
}

function parseWithLogic(text) {
  const lines = text
    .toUpperCase()
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  const joined = lines.join(' ')

  let hotel = null
  let persons = null
  let rooms = 1
  let meal = 'RO'
  let view = detectView(joined)

  // ---- Meal ----
  if (/BB|BREAKFAST/.test(joined)) meal = 'BB'
  if (/HB/.test(joined)) meal = 'HB'
  if (/FB/.test(joined)) meal = 'FB'
  if (/NO\s*MEAL/.test(joined)) meal = 'RO'

  // ---- Persons ----
  const pMatch =
    joined.match(/\b(\d+)\s*(PAX|PERSONS?|PEOPLE)\b/) ||
    joined.match(/\bTOTAL\s*(\d+)\b/)

  if (pMatch) {
    persons = parseInt(pMatch[1], 10)
  }

  // ---- Date Range (simple only) ----
  const dMatch = joined.match(
    /(\d{1,2})\s*[-/]\s*(\d{1,2})\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/
  )

  if (!dMatch || !persons) return []

  const check_in = resolveDate(`${dMatch[1]} ${dMatch[3]}`)
  const check_out = resolveDate(`${dMatch[2]} ${dMatch[3]}`)

  // ---- Hotel ----
  for (const l of lines) {
    if (
      !/\d/.test(l) &&
      !/CHECK|ROOM|PAX|PERSON|BB|RO|HB|FB/.test(l)
    ) {
      hotel = l
      break
    }
  }

  if (!hotel) return []

  const room_type = roomTypeFromPersons(persons)

  return [{
    hotel,
    check_in,
    check_out,
    room_type,
    rooms,
    persons,
    meal,
    view,
    source: 'LOGIC'
  }]
}

module.exports = { parseWithLogic }
