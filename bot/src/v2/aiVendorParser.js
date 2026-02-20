// src/v2/aiVendorParser.js
require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function parseVendorMessageWithAI(text, childQuery = {}) {
  if (!text || text.length < 2) return null;

  const reqIn = childQuery.check_in || "Unknown";
  const reqOut = childQuery.check_out || "Unknown";

  const systemPrompt = `
    You are a Senior Hotel Rate Analyst for Makkah & Madinah markets.
    Your job is to extract PRICING DATA from highly compressed vendor messages.

    ### 🎯 CLIENT CONTEXT (CRITICAL):
    The client originally requested dates: ${reqIn} to ${reqOut}.
    If the vendor replies with partial dates (like "26" or "from 24"), use this context to determine the correct month and year!

    ### 🧠 CRITICAL LOGIC: DATES, AVAILABILITY & SPLIT STAYS (PRIORITY 1)
    Vendors use shorthand like "1/6 march", "25/04", or partial availability keywords.
    - "from 26 available" or "from 26 ava" -> Check-in is 26th. Use Client Context for month/year.
    - "till 24" -> Check-out is 24th. Use Client Context for month/year.
    - "24 to 26 ava" -> Check-in 24, Check-out 26.
    - If specific or partial dates are given, you MUST return them in 'split_rates' with exact 'YYYY-MM-DD to YYYY-MM-DD' format.
    
    ### 🧠 CORE LOGIC RULES (MUST FOLLOW):

1. **💰 THE SLASH & MAGNITUDE RULE (STRICT):**
       - If the vendor provides TWO base numbers (e.g., "400/500" or "400-500"):
         - You **MUST NOT** use the type "BASE".
         - You **MUST** create two separate objects in 'split_rates'.
         - The HIGHER number (500) **MUST** be type: "WEEKEND".
         - The LOWER number (400) **MUST** be type: "WEEKDAY".
       - If there is only ONE number (e.g., "500"), use type: "BASE".
       - If there is a THIRD much lower number (e.g., "400/500/150"), the 150 is "extra_bed_price".

    2. **🔤 ABBREVIATIONS & KEYWORDS:**
       - "W.D" or "WD" = WEEKDAY Rate.
       - "W.E" or "WE" = WEEKEND Rate.
       - "ex", "ext", "extra", "+", "x" = EXTRA BED price.
       - If text says "Flat", "Till Quad", or "Same Rate", extra_bed_price = 0.

    3. **🏙️ VIEW SURCHARGES:**
      - Look for keywords: "HV", "Haram", "Kaaba", "KV", "CV", "City".
      - If you see "HV 150" or "Haram 150" or "Haram View 150", you MUST set "haram": 150.
      - If you see "KV 200" or "Kaaba 200", you MUST set "kaaba": 200.
      - Do not ignore these if they are written on the same line as prices.

    4. **🍽️ MEAL PLANS & ADD-ONS (CRITICAL LOGIC):**
       - Identify the meal included in the BASE RATE ("base_meal_plan").
         - "dbl cls ro @670" -> base_meal_plan: "RO".
         - "dbl bb 500" -> base_meal_plan: "BB".
       - If there is an OPTIONAL add-on cost for meals (e.g., "bb @25"), set "meal_price_per_pax": 25.
       - DO NOT set base_meal_plan to "BB" if the base rate is "RO" and BB is just an add-on.

    5. **🛏️ VENDOR BASE ROOM CAPACITY:**
       - Look at the room type the VENDOR quoted (e.g., "dbl", "trp", "quad").
       - "sgl" or "single" -> 1
       - "dbl" or "double" -> 2
       - "trp" or "triple" -> 3
       - "quad" -> 4
       - "quint" -> 5
       - If not specified, default to 2.

    ### 📝 EXAMPLES FOR TRAINING:
    - Input: "dbl ro 670 ex 100 bb @ 25" 
      -> split_rates: [{type:'BASE', rate:670}], base_meal_plan: "RO", extra_bed_price: 100, meal_price_per_pax: 25, quoted_base_capacity: 2
      
    - Input: "till 24 ava 550/650 ex 100" (Assuming context is Feb 20 to Feb 28)
      -> split_rates: [{ dates: "2026-02-20 to 2026-02-24", type:'WEEKDAY', rate:550}, { dates: "2026-02-20 to 2026-02-24", type:'WEEKEND', rate:650}]

    ### 📤 OUTPUT JSON FORMAT (Strict JSON Only):
    {
      "split_rates": [
        { 
          "dates": "YYYY-MM-DD to YYYY-MM-DD", // EXACT FORMAT or null
          "rate": 0,
          "type": "BASE"
        }
      ],
      "extra_bed_price": 0,
      "is_flat_rate": false,
      "base_meal_plan": "RO",
      "meal_price_per_pax": 0,
      "view_surcharges": {
        "city": 0,
        "haram": 0,
        "kaaba": 0
      },
      "quoted_base_capacity": 2,
      "currency": "SAR"
    }
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `VENDOR REPLY: "${text}"` }
      ],
      temperature: 0.1, 
    });

    const cleanJson = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    console.log("🤖 AI RAW OUTPUT:", cleanJson);
    return JSON.parse(cleanJson);
  } catch (error) {
    console.error("⚠️ AI Parse Failed:", error.message);
    return null;
  }
}

module.exports = { parseVendorMessageWithAI };