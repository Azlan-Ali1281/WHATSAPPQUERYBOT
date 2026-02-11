require('dotenv').config()
const OpenAI = require('openai')

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

async function calculateComplexRate({ child, vendorText }) {
  const q = child.parsed || {}

  const prompt = `
You are a VERY STRICT hotel rate extraction AND formatting engine.

You must do TWO things:
1) Extract structured rate data as JSON
2) Generate FINAL WhatsApp-ready reply text

ABSOLUTE RULES:
- Vendor reply OVERRIDES client request
- NEVER change vendor room type
- NEVER upgrade DBL to QUAD or vice versa
- DO NOT calculate totals
- DO NOT guess missing prices
- DO NOT invent numbers
- Use vendor wording where possible

----------------------------------
PART 1: EXTRACT RATE COMPONENTS
----------------------------------

RULES:

BASE ROOM RATE
- Detect room type keywords: DBL, DOUBLE, TRIPLE, QUAD, QUINT, SUITE
- If a number appears on the SAME line → that is base rate
- If format 500/800 → weekday=500, weekend=800

MEAL
- If "BB" appears on SAME line as base rate → mealIncluded = true
- If "BB 100" → mealIncluded = false, mealRate = 100
- If "BB" mentioned without price → note it

EXTRA BED
- Detect: EX, EXT, EXTRA, EXTRA BED
- If number present → extraBedRate
- If mentioned without number → note it

VIEW
- HV / H.V → Haram View
- KBV → Kaaba View
- PKBV → Partial Kaaba View
- CV → City View
- If number present → viewRate
- If mentioned without number → viewIncluded = true

----------------------------------
PART 2: FORMAT FINAL REPLY
----------------------------------

FORMAT RULES (VERY IMPORTANT):

- FIRST LINE: Hotel name (vendor hotel if mentioned, else query hotel)
- Dates ONLY if vendor mentioned different dates
- ROOM LINE MUST USE VENDOR ROOM TYPE ONLY
- Example:
  DBL RO 300
  DBL BB 1000/1200

- Extra bed shown as:
  EX 50

- Meal shown separately ONLY if not included:
  BB 100

- View shown ONLY if vendor mentioned:
  Haram View 150

- If client asked for view but vendor did not offer:
  Haram View Not Available

- NO emojis
- NO markdown
- NO explanations
- PURE WhatsApp text

----------------------------------
RETURN JSON EXACTLY IN THIS FORMAT:

{
  "breakdown": {
    "vendorRoomType": "DBL|TRIPLE|QUAD|QUINT|SUITE|null",
    "weekdayRate": number|null,
    "weekendRate": number|null,
    "extraBedRate": number|null,
    "mealIncluded": boolean,
    "mealRate": number|null,
    "viewIncluded": boolean,
    "viewRate": number|null,
    "alternativeHotel": string|null,
    "notes": string[]
  },
  "replyText": "FINAL WHATSAPP MESSAGE"
}

----------------------------------
QUERY CONTEXT:
Hotel: ${q.hotel || 'N/A'}
Room Requested: ${q.room_type || 'N/A'}
Meal Requested: ${q.meal || 'RO'}
View Requested: ${q.view || 'NONE'}

VENDOR REPLY:
"""
${vendorText}
"""
`

  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Hotel rate extraction engine' },
        { role: 'user', content: prompt }
      ],
      temperature: 0
    })

    const content = res.choices[0].message.content

    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')

    if (start === -1 || end === -1) {
      console.log('❌ AI did not return JSON')
      console.log('AI RAW OUTPUT:\n', content)
      return null
    }

    const parsed = JSON.parse(content.slice(start, end + 1))

    console.log('🧠 AI RATE EXTRACTION RESULT:', parsed.breakdown)
    console.log('📝 AI FINAL REPLY:\n' + parsed.replyText)

    return parsed
  } catch (err) {
    console.log('❌ Rate extraction AI error:', err.message)
    return null
  }
}

module.exports = { calculateComplexRate }
