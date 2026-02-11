/**
 * RATE EXTRACTOR
 * --------------
 * Extracts rate and resolves meal availability from vendor replies.
 */

function extractRate(text) {
  if (!text) return null

  const nums = text.match(/\b\d{2,5}\b/g)
  if (!nums) return null

  const rates = nums
    .map(n => parseInt(n, 10))
    .filter(n => n >= 50 && n <= 20000)

  if (rates.length === 0) return null

  return Math.min(...rates)
}

function detectVendorMeal(text, requestedMeal) {
  const t = text.toUpperCase()

  // Explicit downgrade
  if (
    /BB\s+NOT\s+AVAILABLE|NO\s+BB|RO\s+ONLY|ROOM\s+ONLY/i.test(t)
  ) {
    return 'RO'
  }

  // Explicit confirmation
  if (/BB\s+AVAILABLE|WITH\s+BB|BB\s+INCLUDED/i.test(t)) {
    return 'BB'
  }

  return requestedMeal || 'RO'
}

module.exports = {
  extractRate,
  detectVendorMeal
}
