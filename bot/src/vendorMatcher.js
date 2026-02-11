/**
 * VENDOR MATCHER
 * --------------
 * Matches vendor replies to the correct child query.
 * Priority:
 * 1) Reply-to (handled in index.js)
 * 2) Hotel name match
 */

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hotelMatches(text, hotelName) {
  if (!text || !hotelName) return false

  const t = normalize(text)
  const h = normalize(hotelName)

  // full match
  if (t.includes(h)) return true

  // partial match (kiswa ↔ kiswa tower)
  const parts = h.split(' ')
  return parts.some(p => p.length > 3 && t.includes(p))
}

function findMatchingChild(text, openChildren) {
  if (!text || !openChildren || openChildren.length === 0) return null

  for (const child of openChildren) {
    if (hotelMatches(text, child.parsed.hotel)) {
      return child
    }
  }

  return null
}

module.exports = {
  findMatchingChild
}
