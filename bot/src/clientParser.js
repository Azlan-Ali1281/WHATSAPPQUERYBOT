/**
 * BASIC CLIENT QUERY PARSER
 * -------------------------
 * Very simple extraction (Phase 4 basic).
 */

function parseClientQuery(text) {
  const lower = text.toLowerCase()

  // HOTEL (last line heuristic)
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const hotel = lines.length ? lines[lines.length - 1] : null

  // ROOM TYPE
  let occupancy = null
  if (lower.includes('single')) occupancy = 'SINGLE'
  else if (lower.includes('double')) occupancy = 'DOUBLE'
  else if (lower.includes('triple')) occupancy = 'TRIPLE'
  else if (lower.includes('quad')) occupancy = 'QUAD'
  else if (lower.includes('quint')) occupancy = 'QUINT'

  // DATES (very basic)
  const dateRegex = /(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi
  const dates = [...text.matchAll(dateRegex)].map(m => m[0])

  return {
    hotel,
    occupancy,
    dates,
    rawText: text
  }
}

module.exports = {
  parseClientQuery
}
