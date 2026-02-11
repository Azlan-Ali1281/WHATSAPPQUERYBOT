/**
 * Format client reply using extracted vendor breakdown
 * NO calculations
 * PURE presentation logic
 */
function formatClientReply(child) {
  const q = child.parsed || {}

  // Get latest breakdown safely
  let r = child.bestRateDetails
  if (!r && Array.isArray(child.vendorReplies) && child.vendorReplies.length > 0) {
    r = child.vendorReplies[child.vendorReplies.length - 1].breakdown
  }

  if (!r) {
    return '⚠️ Rate received but details are unavailable.'
  }

  const lines = []

  // =========================
  // HOTEL NAME
  // =========================
  lines.push(q.hotel)

  // =========================
  // DATES (ONLY IF DIFFERENT)
  // =========================
  if (r.vendorCheckIn && r.vendorCheckOut) {
    if (r.vendorCheckIn !== q.check_in || r.vendorCheckOut !== q.check_out) {
      lines.push(`${r.vendorCheckIn} - ${r.vendorCheckOut}`)
    }
  }

  // =========================
  // ROOM + MEAL LINE
  // =========================
  // 🔴 IMPORTANT: ALWAYS TRUST VENDOR ROOM TYPE FIRST
 // 🔴 ABSOLUTE PRIORITY ORDER
  const vendorRoom =
    child.vendorRoomType ||     // ← persisted from index.js
    r.vendorRoomType ||
    r.roomType ||
    null

  let roomLine = vendorRoom || q.room_type || 'DBL'


  // Meal inclusion in base rate
  if (r.mealIncluded) {
    roomLine += ` ${q.meal || 'BB'}`
  }

  let ratePart = ''

  if (Number.isFinite(r.weekdayRate) && Number.isFinite(r.weekendRate)) {
    ratePart = `${r.weekdayRate}/${r.weekendRate}`
  } else if (Number.isFinite(r.weekdayRate)) {
    ratePart = `${r.weekdayRate}`
  }

  if (ratePart) {
    lines.push(`${roomLine} ${ratePart}`)
  }

  // =========================
  // EXTRA BED
  // =========================
  if (Number.isFinite(r.extraBedRate)) {
    let exLine = 'EX'

    // Extra bed includes BB
    if (r.mealIncluded) {
      exLine += ' BB'
    }

    exLine += ` ${r.extraBedRate}`
    lines.push(exLine)
  }

  // =========================
  // SEPARATE MEALS
  // =========================
  if (!r.mealIncluded && Number.isFinite(r.mealRate)) {
    lines.push(`BB ${r.mealRate}`)
  }

  // =========================
  // VIEW HANDLING
  // =========================
  if (Number.isFinite(r.viewRate)) {
    lines.push(`Haram View ${r.viewRate}`)
  } else if (q.view && !r.viewIncluded) {
    lines.push('Haram View Not Available')
  }

  // =========================
  // NOTES
  // =========================
  if (Array.isArray(r.notes) && r.notes.length > 0) {
    r.notes.forEach(n => lines.push(n))
  }

  return lines.join('\n')
}

module.exports = { formatClientReply }
