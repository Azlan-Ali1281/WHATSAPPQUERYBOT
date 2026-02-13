require('dotenv').config();
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function sanitizeHotelNames(rawList) {
  // 1. Remove obvious duplicates and empty strings
  const uniqueInput = [...new Set(rawList.map(h => h.trim()).filter(Boolean))];
  
  if (uniqueInput.length === 0) return [];

  const prompt = `
  You are a Hotel Data Sanitizer for Makkah and Madinah.
  
  INPUT LIST: ${JSON.stringify(uniqueInput)}
  
  YOUR JOB:
  1. FILTER OUT: Dates (e.g., "12 Feb", "14/20"), Prices ("500 SAR"), or Generic words ("Urgent", "Room", "Booking").
  2. FIX SPELLING: Correct typos for real hotels.
     - "Vocco" -> "Voco Makkah"
     - "Bilul" -> "Bilal"
     - "Kisswa" -> "Kiswah Towers"
  3. PRESERVE KEYWORDS: "Fundaq" means Hotel. DO NOT DELETE IT.
     - "Fundaq Bilul" -> "Fundaq Bilal" or "Hotel Bilal"
  4. AMBIGUITY: If a text looks like a hotel name but you are unsure, KEEP IT. Do not delete it.
  5. CITY NAMES: Keep city context (e.g. "Pullman ZamZam Madinah").
  
  OUTPUT:
  Return ONLY a JSON Array of valid strings.
  Example: ["Voco Makkah", "Swissotel Makkah", "Fundaq Bilal"]
  `;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini', // Fast and cheap
      messages: [{ role: 'user', content: prompt }],
      temperature: 0
    });

    const content = response.choices[0].message.content;
    const start = content.indexOf('[');
    const end = content.lastIndexOf(']');
    
    // If AI fails to return JSON, return original input
    if (start === -1 || end === -1) {
        console.warn("⚠️ Sanitizer returned invalid JSON, using raw input.");
        return uniqueInput; 
    }
    
    const parsed = JSON.parse(content.slice(start, end + 1));
    
    // 🛡️ SAFETY NET: If AI deleted everything but we had valid-looking inputs, revert.
    if (parsed.length === 0 && uniqueInput.some(h => h.length > 4 && !/\d/.test(h))) {
        console.warn("⚠️ Sanitizer deleted all names. Reverting to raw input.");
        // Return uniqueInput but filter out obvious dates (strings with numbers)
        return uniqueInput.filter(h => !/\d/.test(h));
    }
    
    return parsed;

  } catch (error) {
    console.error("⚠️ Sanitizer Error:", error.message);
    // Fallback: Return original input minus obvious dates
    return uniqueInput.filter(h => !/\d{4}/.test(h)); 
  }
}

module.exports = { sanitizeHotelNames };