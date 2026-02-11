const WEEKEND_DAYS = [4, 5] // Thu, Fri

function countNights(checkIn, checkOut) {
  const start = new Date(checkIn)
  const end = new Date(checkOut)
  return Math.round((end - start) / (1000 * 60 * 60 * 24))
}

function extractNumberAfter(keyword, text) {
  const re = new RegExp(`${keyword}\\s*@?\\s*(\\d+)`, 'i')
  const m = text.match(re)
  return m ? parseInt(m[1], 10) : 0
}

function extractFirstNumber(text) {
  const m = text.match(/\d+/)
  return m ? parseInt(m[0], 10) : 0
}

function calculateSimpleRate({ child, vendorText }) {
  const nights = countNights(child.parsed.check_in, child.parsed.check_out)
  const pax = child.parsed.persons || 1

  const text = vendorText.toUpperCase()

  // ---- BASE ROOM RATE ----
  let baseRate = extractFirstNumber(text)
  if (!baseRate) return null

  let perNight = baseRate
  const notes = []

  // ---- EXTRA BED ----
  if (/EXTRA|EX\b/.test(text)) {
    const extra = extractNumberAfter('EX', text)
    const baseOcc =
      child.parsed.room_type === 'DOUBLE' ? 2 :
      child.parsed.room_type === 'TRIPLE' ? 3 :
      child.parsed.room_type === 'QUAD' ? 4 :
      child.parsed.room_type === 'QUINT' ? 5 : pax

    const extraBeds = Math.max(0, pax - baseOcc)
    if (extraBeds > 0 && extra) {
      perNight += extra * extraBeds
      notes.push(`Extra bed x${extraBeds}`)
    }
  }

  // ---- BB EXTRA ----
  if (/BB\s*(\d+)/.test(text) && child.parsed.meal === 'BB') {
    const bb = extractNumberAfter('BB', text)
    if (bb) {
      perNight += bb * pax
      notes.push('Breakfast added')
    }
  }

  // ---- VIEW EXTRA ----
  if (child.parsed.view) {
    const hv =
      extractNumberAfter('HV', text) ||
      extractNumberAfter('HARAM', text) ||
      extractNumberAfter('VIEW', text)

    if (hv) {
      perNight += hv
      notes.push(`${child.parsed.view} added`)
    }
  }

  return {
    perNight,               // ✅ MAIN VALUE
    total: perNight * nights,
    notes
  }
}

module.exports = {
  calculateSimpleRate,
  countNights
}
