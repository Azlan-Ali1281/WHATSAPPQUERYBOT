require('dotenv').config()
const OpenAI = require('openai')

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

async function parseClientMessageWithAI(text) {
  // Get current year for the prompt context
  const currentYear = 2026 
const prompt = `
You are a strict, highly intelligent B2B hotel reservations extraction AI.
CURRENT YEAR: ${currentYear}

### 👑 1. THE GOLDEN RULES (CRITICAL)
- **NO SPLITTING:** "17 Feb to 18 Feb" is ONE stay (1 night). Return ONE object.
- **ROOM COUNTS:** You must strictly extract the number of rooms.
  - "2 dbl" -> { rooms: 2, room_type: "DOUBLE" }
  - "2 rooms 8 people" -> { rooms: 2, persons: 8 }
  - "3 quad" -> { rooms: 3, room_type: "QUAD" }
  - "1 trp" -> { rooms: 1, room_type: "TRIPLE" }
  - Default rooms = 1.
- **SPAM / MISSING DATA:** If the text is just normal chatting, a greeting, or lacks a clear hotel booking intent, return an EMPTY array [] for "queries".

### 🏨 2. HOTEL IDENTIFICATION & ISOLATION
- Identify the hotel name. Ignore guest names (e.g., "Ali", "Ahmed", "Mr.", "Pax").
- If city (Makkah/Madinah) is mentioned, extract the hotel name next to it.
- **MULTI-HOTEL ISOLATION:** If a user pastes multiple hotels in one message, you MUST strictly assign the correct room and dates ONLY to the hotel it was written under. Do not mix and match rooms between hotels. Another hotel's name acts as a wall/barrier.

### 🛏️ 3. ROOM TYPES, OPTIONS & TYPOS
- 1 → SINGLE | 2 → DOUBLE | 3 → TRIPLE | 4 → QUAD | 5 → QUINT
- 6+ → SUITE (unless user explicitly says "2 rooms", etc.)
- "Double bed" -> room_type: "DOUBLE"
- **TYPOS:** Map aggressively: "tripl" = TRIPLE, "qaud/quad" = QUAD, "Executive suite" = SUITE.
- **MULTIPLE TYPES:** If text says "2 dbl and 1 trp", return 2 separate objects.
- **OPTIONS ("OR"):** If a user asks for options like "Double or Quad", you MUST generate TWO separate query objects (one for Double, one for Quad) for that same hotel and date.

### 📅 4. DATE EXTRACTION
- Use standard YYYY-MM-DD.
- "15 to 20 Feb" -> In: 15th, Out: 20th.
- "12/2" or "12-2" -> 12th Feb.
- "Arriving 12 departing 15" -> In: 12th, Out: 15th.

### 📤 RETURN FORMAT (STRICT JSON ONLY)
{
  "queries": [
    {
      "hotel": "Full Name",
      "check_in": "YYYY-MM-DD",
      "check_out": "YYYY-MM-DD",
      "room_type": "TYPE",
      "rooms": 1,
      "persons": 1,
      "meal": "RO/BB/HB/FB",
      "view": "City/Haram/Kaaba",
      "confidence": 1
    }
  ],
  "debug": { "accepted": true, "reason": "Extracted successfully" }
}

MESSAGE:
"""${text}"""
`;

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