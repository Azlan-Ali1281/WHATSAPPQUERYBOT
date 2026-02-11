const { resolveDate } = require('./dateResolver')

// ======================================================
// CITY GUARD
// ======================================================
const CITY_NAMES = new Set(['MAKKAH', 'MECCA', 'MADINAH', 'MEDINA'])

function isPureCityName(name = '') {
  const clean = name
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return CITY_NAMES.has(clean)
}

// ======================================================
// VIEW
// ======================================================
function detectView(text) {
  if (/PARTIAL\s*KAABA/i.test(text)) return 'PARTIAL KAABA VIEW'
  if (/KAABA\s*VIEW/i.test(text)) return 'KAABA VIEW'
  if (/HARAM\s*VIEW/i.test(text)) return 'HARAM VIEW'
  if (/CITY\s*VIEW/i.test(text)) return 'CITY VIEW'
  return null
}

// ======================================================
// ROOM MAP
// ======================================================
const ROOM_MAP = {
  DBL: 'DOUBLE',
  DOUBLE: 'DOUBLE',
  TWIN: 'DOUBLE',
  TRP: 'TRIPLE',
  TRIPLE: 'TRIPLE',
  QUAD: 'QUAD',
  QUINT: 'QUINT',
  SINGLE: 'SINGLE'
}

// ======================================================
// HOTEL EXTRACTION
// ======================================================
function extractHotelLines(text = '') {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => {
      const u = l.toUpperCase()
      if (/\d{1,2}\s*[-/]\s*\d{1,2}/.test(u)) return false
      if (/(DBL|DOUBLE|TRP|TRIPLE|QUAD|QUINT|SINGLE|BB|HB|FB|RO|BED|ROOM|PAX)/.test(u)) return false
      if (isPureCityName(u)) return false
      return true
    })
}

// ======================================================
// ROOM BLOCKS
// ======================================================
function extractRoomBlocks(text = '') {
  const blocks = []
  const t = text.toUpperCase()
  const re = /(\d+)?\s*(DBL|DOUBLE|TWIN|TRP|TRIPLE|QUAD|QUINT|SINGLE)/g

  let m
  while ((m = re.exec(t))) {
    blocks.push({
      rooms: parseInt(m[1] || '1', 10),
      room_type: ROOM_MAP[m[2]]
    })
  }

  return blocks
}

// ======================================================
// NORMALIZER (SINGLE DEFINITION — NO DUPLICATES)
// ======================================================
function normalizeQuery(q, originalText = '') {
  if (!q) return []

  const text = originalText.toUpperCase()

  // ---------- DATES ----------
  let checkIn = resolveDate(q.check_in)
  let checkOut = resolveDate(q.check_out)

  if (!checkIn || !checkOut) return []

  // ---------- HOTELS ----------
  const hotels = extractHotelLines(originalText)
  if (!hotels.length) return []

  // ---------- ROOM ----------
  let globalRoomType = null
  if (q.room_type && typeof q.room_type === 'string') {
    globalRoomType = q.room_type.toUpperCase()
  }

  if (!globalRoomType) {
    for (const k of Object.keys(ROOM_MAP)) {
      if (text.includes(k)) {
        globalRoomType = ROOM_MAP[k]
        break
      }
    }
  }

  const roomBlocks = extractRoomBlocks(text)
  const blocks = roomBlocks.length
    ? roomBlocks
    : [{ rooms: q.rooms || 1, room_type: globalRoomType }]

  // ---------- EXPAND ----------
  const queries = []

  for (const hotel of hotels) {
    for (const block of blocks) {
      queries.push({
        hotel: hotel.toUpperCase(),
        check_in: checkIn,
        check_out: checkOut,
        room_type: block.room_type || globalRoomType,
        rooms: block.rooms,
        persons: q.persons || null,
        meal: q.meal || '',
        view: detectView(text),
        confidence: q.confidence || 1
      })
    }
  }

  return queries
}

module.exports = { normalizeQuery }
