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
  // 🛡️ THE FIX: Grab the requested room type so the AI can compare it!
  const reqRoom = childQuery.room_type || "Unknown";
  // 🛡️ THE FIX 1: Grab the requested meal so we can pass it to the AI!
  const reqMeal = childQuery.meal || "RO";

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

    1. **💰 WEEKEND SURCHARGES & MATH (CRITICAL):**
       - If a vendor says "950 weekend extra 100" or "950 w.e extra 100":
         - This means WEEKDAY is 950.
         - WEEKEND is 950 + 100 = 1050.
         - You MUST do the math and create TWO objects in 'split_rates': one for WEEKDAY (950) and one for WEEKEND (1050).
         - DO NOT confuse "weekend extra" with "extra bed_price".

    2. **💰 THE SLASH & MAGNITUDE RULE (SMART DETECTION):**
       - If the vendor provides TWO numbers separated by a slash or dash (e.g., "400/500" or "120/20"):
         - **STEP A (Check for Extra Bed):** Compare the two numbers. If the second number is significantly smaller (e.g., it is less than 40% of the first number, like 120/20 or 900/150):
           - The first number (120) is the "BASE" rate.
           - The second number (20) is the "extra_bed_price".
           - DO NOT create split_rates for this; just return one "BASE" rate.
         - **STEP B (Check for Weekend/Weekday):** If the numbers are closer in value (e.g., 400/500 or 950/1050):
           - You MUST create two separate objects in 'split_rates'.
           - The HIGHER number (500) MUST be type: "WEEKEND".
           - The LOWER number (400) MUST be type: "WEEKDAY".
       - If there is only ONE number (e.g., "500"), use type: "BASE".
       - If there is a THIRD much lower number (e.g., "400/500/150"), the 150 is always "extra_bed_price".

    3. **🔤 ABBREVIATIONS & KEYWORDS:**
       - "W.D" or "WD" = WEEKDAY Rate.
       - "W.E" or "WE" = WEEKEND Rate.
       - "ex bed", "ext bed", "extra bed", "+ bed" = EXTRA BED price.
       - "ex 120" usually means extra bed. Look at context to separate it from "weekend extra".

    4. **🏙️ VIEW SURCHARGES:**
      - Look for keywords: "HV", "Haram", "Kaaba", "KV", "CV", "City".
      - If you see "HV 150" or "Haram 150", set "haram": 150.
      - If you see "KV 200" or "Kaaba 200", set "kaaba": 200.

    5. **🍽️ MEAL PLANS & ADD-ONS (CRITICAL LOGIC):**
       - The client requested: ${reqMeal}.
       - Identify the meal included in the BASE RATE ("base_meal_plan").
       - "dbl cls ro @670" -> base_meal_plan: "RO".
       - IF THE VENDOR DOES NOT MENTION ANY MEAL: Assume the vendor is quoting for the client's requested meal. Set "base_meal_plan" to "${reqMeal}".
       - If there is an OPTIONAL add-on cost for meals (e.g., "bb @25"), set "meal_price_per_pax": 25.

    6. **🛏️ VENDOR BASE ROOM CAPACITY:**
       - "sgl" -> 1 | "dbl" or "twin" -> 2 | "trp" -> 3 | "quad" -> 4 | "quint" -> 5
       - Default to 2 if missing.

    7. **### ROOM TYPE MISMATCH (CRITICAL RULE):**
        - The client requested: ${reqRoom}.
        - If the vendor explicitly offers a DIFFERENT room type, extract it into "offered_room_type".
        - Leave empty if no room is mentioned.

    ### 📤 OUTPUT JSON FORMAT (Strict JSON Only):
    {
      "is_valid": true,
      "offered_room_type": "",
      "split_rates": [
        { 
          "dates": "YYYY-MM-DD to YYYY-MM-DD",
          "rate": 0,
          "extra_bed_rate": 0,
          "type": "BASE | WEEKDAY | WEEKEND"
        }
      ],
      "extra_bed_price": 0,
      "is_flat_rate": false,
      "base_meal_plan": "${reqMeal}",
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