/**
 * BASIC VENDOR RATE PARSER (FIXED)
 * --------------------------------
 * Accepts real-world vendor formats.
 */

function parseVendorReply(text) {
  const lower = text.toLowerCase()

  // RATE (sr 650 | sr.650 | @ 650 | 650)
  let rate = null

  const srMatch = lower.match(/sr\.?\s?(\d+)/)
  const atMatch = lower.match(/@\s?(\d+)/)
  const plainNumberMatch = lower.match(/\b(\d{3,5})\b/)

  if (srMatch) rate = parseInt(srMatch[1], 10)
  else if (atMatch) rate = parseInt(atMatch[1], 10)
  else if (plainNumberMatch) rate = parseInt(plainNumberMatch[1], 10)

  // OCCUPANCY
  let occupancy = null
  if (lower.includes('single')) occupancy = 'SINGLE'
  else if (lower.includes('double') || lower.includes('dbl')) occupancy = 'DOUBLE'
  else if (lower.includes('triple')) occupancy = 'TRIPLE'
  else if (lower.includes('quad')) occupancy = 'QUAD'
  else if (lower.includes('quint')) occupancy = 'QUINT'

  // MEAL
  let meal = null
  if (lower.includes('ro')) meal = 'RO'
  else if (lower.includes('bb')) meal = 'BB'

  return {
    rate,
    occupancy,
    meal,
    rawText: text
  }
}

module.exports = {
  parseVendorReply
}
