require('dotenv').config()
const OpenAI = require('openai')

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

/* =====================================================
   🔒 HARD GUARDS (NO AI — ORIGINAL + SAFE ADDITIONS)
   ===================================================== */

/**
 * Detect explicit check-in / check-out language
 * (ORIGINAL — DO NOT REMOVE)
 */
function hasExplicitCheckInOut(text = '') {
  const t = text.toLowerCase()
  return (
    /(check\s*in|chk\s*in|ck\s*in|arrival|from)/i.test(t) &&
    /(check\s*out|chk\s*out|ck\s*out|departure|to|till)/i.test(t)
  )
}

/**
 * Extract explicit date lines AS-IS
 * (ORIGINAL — DO NOT FORMAT)
 */
function extractExplicitDateRange(text = '') {
  return text
    .split('\n')
    .filter(l =>
      /(check\s*in|chk\s*in|ck\s*in|arrival|from|check\s*out|chk\s*out|ck\s*out|departure|to|till)/i.test(
        l
      )
    )
    .join(' ')
    .trim()
}

/**
 * Extract hotel-looking lines
 * 🔒 UPDATED: "ODST" is VALID, "SIMILAR" is NOT
 */
function extractHotels(text = '') {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => {
      const u = l.toUpperCase()

      // ❌ skip pure date lines
      if (/^\d{1,2}\s*(\/|-)\s*\d{1,2}/.test(u)) return false

      // ❌ skip check-in / out labels
      if (/(CHECK\s*-?\s*IN|CHECK\s*-?\s*OUT|CHK\s*IN|CHK\s*OUT|ARRIVAL|DEPARTURE)/i.test(u)) {
        return false
      }

      // ❌ skip pax / room-only lines
      if (/(PAX|PERSONS?|SINGLE|DOUBLE|DBL|TRIPLE|TRP|QUAD|QUINT|HEX|HEXA|SUITE|ROOM)/i.test(u)) {
        return false
      }

      // ❌ skip city-only lines
      if (/^(MAKKAH|MECCA|MADINAH|MEDINA)$/i.test(u)) {
        return false
      }

      // ❌ skip "similar"
      if (u === 'SIMILAR') return false

      // ✅ KEEP anything human-readable (hotel names)
      return u.split(' ').length >= 2 || /^[A-Z]{3,7}$/i.test(u)
    })
}


/**
 * Extract global room (ORIGINAL behavior)
 */
function extractGlobalRoom(text = '') {
  const t = text.toUpperCase()
  if (t.includes('SINGLE')) return 'SINGLE'
  if (t.includes('DOUBLE') || t.includes('DBL')) return 'DOUBLE'
  if (t.includes('TRIPLE') || t.includes('TRP')) return 'TRIPLE'
  if (t.includes('QUAD')) return 'QUAD'
  if (t.includes('QUINT')) return 'QUINT'
  if (t.includes('HEX') || t.includes('HEXA')) return 'HEXA'
  if (t.includes('SUITE')) return 'SUITE'
  return null
}

/**
 * 🔒 NEW SAFE FALLBACK
 * Used ONLY if AI returns ZERO blocks
 */
function buildSingleFallbackBlock(text = '') {
  const hotels = extractHotels(text)
  if (!hotels.length) return null

  // try to extract numeric date range like 22/24 feb, 12 to 14 march
  const dateLine =
    text
      .split('\n')
      .find(l => /\d{1,2}\s*(\/|-|to)\s*\d{1,2}/i.test(l)) || ''

  if (!dateLine) return null

  return {
    blocks: [
      {
        dates: dateLine.trim(),
        hotels
      }
    ],
    global: {
      room: extractGlobalRoom(text),
      meal: null,
      view: null
    }
  }
}

/* =====================================================
   🤖 AI #1 — SEGMENTATION (ORIGINAL PROMPT UNCHANGED)
   ===================================================== */

async function segmentClientQuery(text) {
  // ✅ HARD OVERRIDE — explicit check-in / check-out
  if (hasExplicitCheckInOut(text)) {
    return {
      blocks: [
        {
          dates: extractExplicitDateRange(text),
          hotels: extractHotels(text)
        }
      ],
      global: {
        room: extractGlobalRoom(text),
        meal: null,
        view: null
      }
    }
  }

  // =========================
  // ORIGINAL AI SEGMENTATION
  // =========================
  const prompt = `
You are a STRICT query segmentation engine.

Your ONLY job:
- Split the message into DATE BLOCKS
- List HOTEL NAMES under each date block
- Extract GLOBAL preferences that apply to ALL blocks

RULES:
- DO NOT format dates
- DO NOT invent hotels
- DO NOT validate
- DO NOT merge date ranges
- DO NOT infer prices
- DO NOT infer room if missing

GLOBAL fields apply to ALL blocks unless overridden.

RETURN JSON ONLY in this exact format:

{
  "blocks": [
    {
      "dates": "raw date text exactly as written",
      "hotels": ["hotel line 1", "hotel line 2"]
    }
  ],
  "global": {
    "room": "DOUBLE|TRIPLE|QUAD|SINGLE|null",
    "meal": "BB|HB|FB|RO|null",
    "view": "HARAM VIEW|KAABA VIEW|CITY VIEW|null"
  }
}

MESSAGE:
"""
${text}
"""
`

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Query segmentation engine' },
      { role: 'user', content: prompt }
    ],
    temperature: 0
  })

  const content = res.choices[0].message.content
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')

  if (start === -1 || end === -1) {
    throw new Error('Segmentation AI returned invalid JSON')
  }

  const parsed = JSON.parse(content.slice(start, end + 1))

  // 🔒 ADDITIVE SAFETY NET — DO NOT BREAK OLD LOGIC
  if (!parsed.blocks || parsed.blocks.length === 0) {
    const fallback = buildSingleFallbackBlock(text)
    if (fallback) return fallback
  }

  return parsed
}

module.exports = { segmentClientQuery }
