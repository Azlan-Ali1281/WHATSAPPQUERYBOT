/**
 * OWNER MESSAGE FORMATTER
 */

function formatOwnerBooking(query) {
  return (
    `📌 BOOKING CONFIRMED\n\n` +
    `Hotel: ${query.parsed?.hotel || 'N/A'}\n` +
    `Dates: ${query.parsed?.dates?.join(', ') || 'N/A'}\n` +
    `Room: ${query.bestRate?.parsed?.occupancy || 'N/A'}\n` +
    `Meal: ${query.bestRate?.parsed?.meal || 'N/A'}\n` +
    `Rate: SR ${query.bestRate?.rate}\n\n` +
    `Client Query:\n${query.text}`
  )
}

module.exports = {
  formatOwnerBooking
}
