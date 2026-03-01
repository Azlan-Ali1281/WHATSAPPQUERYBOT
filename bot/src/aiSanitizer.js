require('dotenv').config();
const OpenAI = require('openai');
const { getDatabase } = require('./database'); // 🛡️ Import DB to fetch the dynamic registry

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function sanitizeHotelNames(rawHotels) {
  if (!rawHotels || rawHotels.length === 0) return [];

  // 🛡️ FETCH DYNAMIC REGISTRY FROM DATABASE
  const db = getDatabase();
  let OFFICIAL_REGISTRY = [];
  try {
      const rows = db.prepare("SELECT name FROM hotel_registry ORDER BY name ASC").all();
      OFFICIAL_REGISTRY = rows.map(r => r.name);
  } catch (e) {
      console.error("Failed to fetch registry for AI:", e);
  }

  const systemPrompt = `
    You are the Guardian of the Hotel Database for Makkah and Madinah.
    
    ### 1. 📋 THE OFFICIAL REGISTRY (PRIORITY MATCHING)
    Use the list below as the source of truth. 
    If the user's input implies one of these hotels, output the **EXACT STRING** from this list.
    
    ${JSON.stringify(OFFICIAL_REGISTRY)}

    ### 2. 🧠 MATCHING RULES
    - **Exact Match:** "Makkah Hotel" -> "Makkah Hotel"
    - **Fuzzy Match:** "Makah htl" -> "Makkah Hotel"
    - **No Hallucination:** If a hotel has a strong identifier (e.g., "Gulnar", "Manar", "Emaar"), DO NOT map it to a registry hotel (like "Taiba Front") just because they share a word.
    - **Specific Brands:** "Gulnar Taiba" is a specific hotel. If it's not in the registry, just return "Gulnar Taiba" cleaned, do NOT change it to "Taiba Front"."Taibah Madinah" is also a different hotel
    - **Ambiguity:** - "Hilton" -> "Hilton Makkah Convention" (Default preference)
      - "Swiss" -> "Swissotel Makkah"
      - "Voco" -> "Voco Makkah"
      - "Anwar" -> "Anwar Al Madinah"
      - "Kiswa" -> "Kiswa Towers"
      - "Al Harthia" -> "Frontel Al Harithia"
    - **Differentiation:**
      - "Makkah Hotel" and "Makkah Towers" are DIFFERENT. Respect the user's choice.
      - "Emaar Grand" vs "Emaar Elite" vs "Emaar Royal". Don't mix them.
      - "Saja Makkah" vs "Saja Madinah". Don't mix them.
      - "Dar Al Taqwa" vs "Maysan Altaqwa" - Don't mix them.

    ### 3. 🛡️ SANITIZATION RULES
    - **Unknown Hotels:** If the hotel is VALID but NOT in the Official Registry (e.g. "Four Points"), just fix the spelling. DO NOT force it into the registry.
    - **Garbage Removal:** - Remove dates ("5 mar"), room types ("Quad"), meals ("BB").
      - If input is NOT a hotel (e.g. "2 rooms"), remove it entirely.

    ### 4. OUTPUT
    - Return a clean JSON array of strings.
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(rawHotels) }
      ],
      temperature: 0.1,
    });

    const rawContent = response.choices[0].message.content.trim();
    const cleanJson = rawContent.replace(/```json|```/g, '').trim();
    
    return JSON.parse(cleanJson);

  } catch (error) {
    console.error("⚠️ AI Sanitizer Failed:", error.message);
    return rawHotels; 
  }
}

module.exports = { sanitizeHotelNames };