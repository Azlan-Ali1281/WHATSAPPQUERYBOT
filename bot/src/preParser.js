/**
 * PRE-PARSER
 * ----------
 * Splits WhatsApp messages into logical booking blocks
 */

const DATE_RANGE_REGEX =
  /(\b\d{1,2}\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b|\b\d{1,2}[\/\-]\d{1,2}\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b|CHECK\s*IN)/i

function normalizeLines(text = '') {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
}

function isDateLine(line) {
  return DATE_RANGE_REGEX.test(line)
}

function isNoiseLine(line) {
  return (
    /^\d+$/.test(line) ||            // phone numbers
    /^[A-Z]{2,5}\s*\d+$/i.test(line) // rates like "SR 1200"
  )
}

/**
 * 🔒 MAIN PRE-PARSER
 * Splits a WhatsApp message into logical booking blocks
 */
function splitIntoBookingBlocks(text = '') {
  const lines = normalizeLines(text)

  const blocks = []
  let currentBlock = []
  let lastDateIndex = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (isNoiseLine(line)) continue

    if (isDateLine(line)) {
      // If we already saw a date earlier, start a NEW block
      if (lastDateIndex !== -1 && currentBlock.length) {
        blocks.push(currentBlock.join('\n'))
        currentBlock = []
      }
      lastDateIndex = i
    }

    currentBlock.push(line)
  }

  if (currentBlock.length) {
    blocks.push(currentBlock.join('\n'))
  }

  return blocks
}

module.exports = { splitIntoBookingBlocks }
