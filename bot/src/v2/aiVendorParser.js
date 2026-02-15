// src/v2/aiVendorParser.js
require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function parseVendorMessageWithAI(text) {
  if (!text || text.length < 2) return null;

  const systemPrompt = `
    You are a Senior Hotel Rate Analyst for Makkah & Madinah markets.
    Your job is to extract PRICING DATA from vendor messages.

    ### 🧠 CRITICAL LOGIC: DATES & SPLIT STAYS (PRIORITY 1)
    Vendors use shorthand like "1/6 march" or "1-6 mar" or "25/04".
    - "1/6 march" means Check-in: 1st, Check-out: 6th.
    - If specific dates are given, you MUST return them in the 'split_rates' array with the exact date range.
    - **Year Assumption:** Always assume the current/next logical year (e.g. 2026).
    
    Example Input: 
    "1-6 march 485, 6-9 march 585"
    
    Example Output:
    {
      "split_rates": [
        { "dates": "2026-03-01 to 2026-03-06", "rate": 485, "type": "BASE" },
        { "dates": "2026-03-06 to 2026-03-09", "rate": 585, "type": "BASE" }
      ]
    }

    ### 🧠 CORE LOGIC RULES (MUST FOLLOW):

    1. **💰 BASE RATE vs. SPLIT RATES:**
       - **Single Number:** "450" → { type: 'BASE', rate: 450, dates: null }
       - **Weekday/Weekend (Slash):** Numbers are CLOSE (e.g., "1150/1250") → WD: 1150, WE: 1250.
       - **Base/Extra Bed (Slash):** 2nd number is MUCH LOWER (e.g., "750/125") → Base: 750, Extra: 125.
       - **Explicit Keys:** "WD 1780 WE 2130" → WD: 1780, WE: 2130.

    2. **🛏️ EXTRA BED LOGIC:**
       - Look for keywords: "ex", "ext", "extra", "extra bed".
       - If format is "1100 ext 100", extra_bed_price = 100.
       - If text says "**Flat**", "**Till Quad**", or "**Same Rate**", then extra_bed_price = 0 (Rate applies to all occupancies).

    3. **🕌 VIEW SURCHARGES (ADD-ONS):**
       - Detect abbreviations: **KV** (Kaaba View), **HV** (Haram View), **CV** (City View).
       - If a price follows (e.g., "KV 650"), it is a **SURCHARGE** to be added to the base rate.
       - Example: "1150... KV 650" → Base: 1150, view_surcharges: { kaaba: 650 }.

    4. **🍽️ MEAL PLANS:**
       - Keywords: **RO** (Room Only), **BB** (Breakfast), **Suhoor**, **Iftar**, **HB**, **FB**.
       - **Price Detection:**
         - "140 sahoo" → Meal: Suhoor, Price: 140 (Per Person).
         - "With Suhoor" (no number) → Meal: Suhoor, Price: 0 (Included in Base).
         - "BB 35 PP" → Meal: BB, Price: 35.

    5. **📅 DATES:**
       - If the vendor explicitly mentions a date range (e.g., "5-9 mar", "25/04"), extract it.
       - If multiple ranges are given with different prices, return them as an array in 'split_rates'.

    ### 📝 EXAMPLES FOR TRAINING:
    - Input: "700/120" 
      -> { split_rates: [{type:'BASE', rate:700, dates: null}], extra_bed_price: 120 }
    - Input: "1150/1250 EX 120" 
      -> { split_rates: [{type:'WEEKDAY', rate:1150}, {type:'WEEKEND', rate:1250}], extra_bed_price: 120 }
    - Input: "575 ro flat" 
      -> { split_rates: [{type:'BASE', rate:575}], is_flat_rate: true }
    - Input: "KV 650 HV 150" 
      -> { view_surcharges: { kaaba: 650, haram: 150 } }

    ### 📤 OUTPUT JSON FORMAT (Strict JSON Only):
    {
      "split_rates": [
        { 
          "dates": "YYYY-MM-DD to YYYY-MM-DD", // EXACT FORMAT or null (for global)
          "rate": 0,
          "type": "BASE" // or WEEKDAY / WEEKEND
        }
      ],
      "extra_bed_price": 0,
      "is_flat_rate": false,
      "meal_plan": null,
      "meal_price_per_pax": 0,
      "view_surcharges": {
        "city": 0,
        "haram": 0,
        "kaaba": 0
      },
      "currency": "SAR"
    }
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Fast & Cost-Effective
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `VENDOR REPLY: "${text}"` }
      ],
      temperature: 0.1, // Low temp prevents hallucination
    });

    const cleanJson = response.choices[0].message.content.replace(/```json|```/g, '').trim();
    
    // 🔍 DEBUG LOG: See exactly what the AI returned
    console.log("🤖 AI RAW OUTPUT:", cleanJson);

    return JSON.parse(cleanJson);

  } catch (error) {
    console.error("⚠️ AI Parse Failed:", error.message);
    return null;
  }
}

module.exports = { parseVendorMessageWithAI };