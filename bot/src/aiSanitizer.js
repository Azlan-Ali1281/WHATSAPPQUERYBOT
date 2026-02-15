// src/aiSanitizer.js
require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 📋 THE GOLDEN LIST (Matches your GroupConfig Keys exactly)
const OFFICIAL_REGISTRY = [
  // 🕌 MADINAH
  "Anwar Al Madinah", "Saja Al Madinah", "Pullman Zamzam Madinah", "Madinah Hilton", 
  "Shahd Al Madinah", "The Oberoi Madina", "Dar Al Taqwa", "Dar Al Iman InterContinental", 
  "Dar Al Hijra InterContinental", "Movenpick Madinah", "Crowne Plaza Madinah", 
  "Leader Al Muna Kareem", "Odst Al Madinah", "Artal Al Munawara", "Zowar International", 
  "Taiba Front", "Aqeeq Madinah", "Frontel Al Harithia", "Dallah Taibah", 
  "Golden Tulip Al Zahabi", "Al Mukhtara International", "Al Haram Hotel", "Province Al Sham",
  
  // 🕋 MAKKAH (Clock Tower)
  "Fairmont Makkah Clock Royal Tower", "Swissotel Makkah", "Swissotel Al Maqam", 
  "Raffles Makkah Palace", "Pullman Zamzam Makkah", "Movenpick Hajar Tower", 
  "Al Marwa Rayhaan by Rotana", "Makkah Hotel", "Makkah Towers",

  // 🕋 MAKKAH (Haram/Jabal Omar)
  "Hilton Makkah Convention", "Hilton Suites Makkah", "Hyatt Regency Makkah", 
  "Conrad Makkah", "Jabal Omar Marriott", "Address Jabal Omar", 
  "Sheraton Makkah Jabal Al Kaaba", "DoubleTree by Hilton Makkah", 
  "Le Meridien Makkah", "Waqf Uthman",

  // 🚌 MAKKAH (Aziziyah/Shuttle)
  "Voco Makkah", "Kiswa Towers", "Elaf Ajyad", "Le Meridien Towers Makkah", 
  "Novotel Makkah Thakher City", "Holiday Inn Makkah Al Aziziah"
];

async function sanitizeHotelNames(rawHotels) {
  if (!rawHotels || rawHotels.length === 0) return [];

  const systemPrompt = `
    You are the Guardian of the Hotel Database for Makkah and Madinah.
    
    ### 1. 📋 THE OFFICIAL REGISTRY (PRIORITY MATCHING)
    Use the list below as the source of truth. 
    If the user's input implies one of these hotels, output the **EXACT STRING** from this list.
    
    ${JSON.stringify(OFFICIAL_REGISTRY)}

    ### 2. 🧠 MATCHING RULES
    - **Exact Match:** "Makkah Hotel" -> "Makkah Hotel"
    - **Fuzzy Match:** "Makah htl" -> "Makkah Hotel"
    - **Ambiguity:** - "Hilton" -> "Hilton Makkah Convention" (Default preference)
      - "Swiss" -> "Swissotel Makkah"
      - "Voco" -> "Voco Makkah"
      - "Anwar" -> "Anwar Al Madinah"
      - "Kiswa" -> "Kiswa Towers"
    - **Differentiation:**
      - "Makkah Hotel" and "Makkah Towers" are DIFFERENT. Respect the user's choice.
      - "Emaar Grand" vs "Emaar Elite" vs "Emaar Royal". Don't mix them.

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
      temperature: 0.1, // Low temp for precision
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