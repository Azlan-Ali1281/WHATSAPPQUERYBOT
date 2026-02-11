/**
 * SIMPLE QUERY DETECTOR
 * ---------------------
 * Decides whether logic parser should be used.
 */

function isSimpleQuery(text) {
  if (!text) return false

  const t = text.toUpperCase()

  // 1️⃣ HARD COMPLEX SIGNALS
  if (
    /(AGAIN|THEN|TOTAL|TRAVEL|MID DAY|OPTIONS|ITINERARY|MAKKAH\s+MADINA|MADINA\s+MAKKAH)/i.test(
      t
    )
  ) {
    return false
  }

  // 2️⃣ COUNT DATE RANGES (support - and /)
  const dateMatches = t.match(
    /\d{1,2}\s*[-/]\s*\d{1,2}\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/g
  )

  if (dateMatches && dateMatches.length > 1) {
    return false // multiple date ranges → complex
  }

  // 3️⃣ MUST HAVE AT LEAST ONE DATE + ONE ROOM
  const hasDate =
    /\d{1,2}\s*[-/]\s*\d{1,2}\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/.test(
      t
    )

  const hasRoom =
    /\b(DBL|DOUBLE|TWIN|TRIPLE|QUAD|QUINT|SINGLE)\b/.test(t)

  if (!hasDate || !hasRoom) {
    return false
  }

  // 4️⃣ IGNORE POLITE / NOISE WORDS
  // hello, need rates, please, etc → allowed

  return true
}

module.exports = {
  isSimpleQuery
}
