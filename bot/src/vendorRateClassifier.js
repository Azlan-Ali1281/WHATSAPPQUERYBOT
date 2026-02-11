/**
 * Determine whether vendor rate is simple or complex
 * Simple = ONE flat number only
 */
function isSimpleRate(text) {
  if (!text) return false

  const clean = text.toLowerCase()

  // ❌ If it contains any complex indicators → NOT simple
  const complexKeywords = [
    'bb',
    'breakfast',
    'ex',
    'extra',
    'bed',
    'hv',
    'h.v',
    'view',
    '/',
    'weekend',
    'weekday'
  ]

  if (complexKeywords.some(k => clean.includes(k))) {
    return false
  }

  // Count numbers
  const numbers = clean.match(/\d+/g) || []

  // ✅ Simple ONLY if exactly one number
  return numbers.length === 1
}

module.exports = { isSimpleRate }
