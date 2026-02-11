require('dotenv').config()
const OpenAI = require('openai')

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

async function parseClientMessageWithAI(text) {
  // Get current year for the prompt context
  const currentYear = 2026 
const prompt = `
You are a senior hotel reservations agent.
CURRENT YEAR: ${currentYear}

Your job is to decide ONE thing first:
➡️ Is there a CLEAR HOTEL NAME present (even if city is also present)?

IMPORTANT CLARIFICATION:
- City names (Makkah, Medina) MAY appear together with hotel names.
- Hotel names often appear with numbers next to them (e.g., "Taiba front 2 quad"). "Taiba front" is the hotel.
- DO NOT reject just because a room type or number is on the same line as the hotel.

--------------------------------
STRICT BUSINESS RULES
--------------------------------
- ASSUME THE YEAR IS ${currentYear} unless specified otherwise.
- If a line is a person's name (e.g., "Azlan", "Muhammad Ali", "Zameer"), it is NOT a hotel.
- If the confidence in a hotel name is low because it looks like a guest name, return confidence: 0.
- Only extract names of known buildings or accommodation providers.
- "Makkah" or "Madinah" are cities, not hotels—only extract what follows them.
- NEVER split persons into multiple rooms unless user explicitly says so.
- If rooms not mentioned → rooms = 1.
- Determine room_type from persons:
  1 → SINGLE
  2 → DOUBLE
  3 → TRIPLE
  4 → QUAD
  5 → QUINT
  6–9 → SUITE (MUST include persons count)

- If room type missing → "DOUBLE + EXTRA BED"
- If "no meals" → RO
- If text contains SUHOOR → meal = SUHOOR
- If text contains IFTAR → meal = IFTAR
- If both → SUHOOR+IFTAR
- Ignore guest name.
- DO NOT invent hotel names.
- DO NOT guess missing dates.
- If hotel name AND dates are present, the query is VALID even if room type is missing.
-MULTIPLE ROOM TYPES: If the text mentions different room types (e.g., "2 quad and 1 trp"), you MUST return a SEPARATE object for each type in the "queries" array. 
Example: [ {room_type: "QUAD", rooms: 2}, {room_type: "TRIPLE", rooms: 1} ]
-DATE RANGE: If the text says "04 to 20 march", this is ONE stay. 
check_in: 2026-03-04, check_out: 2026-03-20. 
DO NOT create a separate query for every single day.

--------------------------------
NEW: MULTI-ROOM TYPE & DATE RANGE RULES
--------------------------------
1. MULTIPLE ROOM TYPES: If the text mentions different room types (e.g., "2 quad and 1 trp"), you MUST return a SEPARATE object for each type in the "queries" array. 
   Example: [ {room_type: "QUAD", rooms: 2}, {room_type: "TRIPLE", rooms: 1} ]
2. DATE RANGE: If the text says "04 to 20 march", this is ONE stay. 
   check_in: 2026-03-04, check_out: 2026-03-20. 
   DO NOT create a separate query for every single day.
3. ROOMS: Specifically look for numbers tied to room types (e.g., "2 quad" -> rooms: 2, room_type: "QUAD"). 
4. DEFAULT ROOMS: If no room number is explicitly mentioned, set rooms: 1.
5. DATE INTERPRETATION: Use the year ${currentYear}. ALL dates must be YYYY-MM-DD (e.g., ${currentYear}-03-04). 
   NEVER return 2024 or 2025.

--------------------------------
DATE INTERPRETATION RULE (VERY IMPORTANT)
--------------------------------
* Formats like "9-10 FEB" or "9/10 FEB" or "9 to 10 FEB" mean:
  - check-in = ${currentYear}-02-09
  - check-out = ${currentYear}-02-10
* ALL DATES MUST BE IN ${currentYear} OR LATER. NEVER RETURN 2024 or 2025.

--------------------------------
REJECTION RULES (EXPLICIT)
--------------------------------
Reject ONLY if:
- No hotel name AND no specific area/distance.
- Missing check-in or check-out.
- Impossible dates.

--------------------------------
RETURN FORMAT (MANDATORY)
--------------------------------
Return ONLY JSON in this exact shape:

{
  "queries": [
    {
      "hotel": "",
      "check_in": "YYYY-MM-DD",
      "check_out": "YYYY-MM-DD",
      "room_type": "",
      "rooms": 1,
      "persons": number,
      "meal": "",
      "view": null,
      "confidence": number
    }
  ],
  "debug": {
    "accepted": true,
    "reason": "WHY YOU ACCEPTED"
  }
}

MESSAGE:
"""${text}"""
`

  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Hotel booking extraction engine' },
        { role: 'user', content: prompt }
      ],
      temperature: 0
    })

    const content = res.choices[0].message.content
    console.log('\n🧠 AI RAW OUTPUT:\n', content)

    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')

    if (start === -1 || end === -1) {
      console.log('❌ AI returned non-JSON response')
      return { queries: [] }
    }

    const parsed = JSON.parse(content.slice(start, end + 1))

    if (parsed.debug) {
      console.log(
        `🧪 AI DEBUG → accepted: ${parsed.debug.accepted}, reason: ${parsed.debug.reason}`
      )
    }

    return parsed
  } catch (e) {
    console.error('❌ AI parser error:', e.message)
    return { queries: [] }
  }
}

module.exports = { parseClientMessageWithAI }