/**
 * MESSAGE CLASSIFIER
 * -------------------
 * Determines message intent safely
 */

// src/messageClassifier.js
const { getContextBySentMsgId, getLastActiveRequest } = require('./database');

function normalize(text) {
  return text.toLowerCase().trim()
}

function isConfirmation(text) {
  const t = normalize(text)
  return (
    t === 'confirm' ||
    t === 'confirmed' ||
    t.includes('confirm') ||
    t.includes('book') ||
    t.includes('ok proceed') ||
    t.includes('yes proceed')
  )
}

/**
 * HARD FILTER:
 * Does this message LOOK like a hotel query attempt?
 */
function looksLikeQuery(text) {
  if (!text) return false
  const t = normalize(text)

  // ignore ultra-short noise
  if (t.length < 5) return false

  // --------------------------------------------------
  // DATES (single date OR range)
  // --------------------------------------------------

  // 06 march / 6 march
  if (/\b\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(t)) {
    return true
  }

  // 06-14 march / 6-14 mar
  if (
    /\b\d{1,2}\s*[-–]\s*\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(t)
  ) {
    return true
  }

  // --------------------------------------------------
  // ROOM TYPES (extended safely)
  // --------------------------------------------------
  if (
    /\b(single|double|dbl|trp|triple|quad|quint|suite)\b/.test(t)
  ) {
    return true
  }

  // --------------------------------------------------
  // pax / persons
  // --------------------------------------------------
  if (/\b\d+\s*(pax|person|persons|people)\b/.test(t)) {
    return true
  }

  // --------------------------------------------------
  // hotel intent words
  // --------------------------------------------------
  // hotel intent words (EN + AR transliteration)
  if (/\b(hotel|stay|room|booking|tower|rates|price|fundaq|fندق)\b/.test(t)) {
    return true
  }


  // --------------------------------------------------
  // city + stay intent
  // --------------------------------------------------
  if (
    /\b(makkah|mecca|madina|medina)\b/.test(t) &&
    /\b(stay|hotel|room)\b/.test(t)
  ) {
    return true
  }

  // --------------------------------------------------
  // FALLBACK: date + hotel-like words (order-agnostic)
  // --------------------------------------------------
  if (
    /\b\d{1,2}\s*[-–]\s*\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/.test(t) &&
    /\b[a-z]{4,}\b/.test(t)
  ) {
    return true
  }

  return false
}

function looksLikeRate(text) {
  const t = normalize(text)
  return (
    t.includes('sr') ||
    t.includes('sar') ||
    t.includes('@') ||
    t.includes('rate') ||
    t.includes('ro') ||
    t.includes('bb')
  )
}

function classifyMessage({ groupRole, text, msg }) {
  if (!text || !text.trim()) {
    return 'IGNORE'
  }

  // CLIENT SIDE
  if (groupRole === 'CLIENT') {
    if (isConfirmation(text)) {
      return 'CLIENT_CONFIRM'
    }

    if (looksLikeQuery(text)) {
      return 'CLIENT_QUERY'
    }

    // normal chat → ignore
    return 'IGNORE'
  }

  // VENDOR SIDE
if (groupRole === 'VENDOR') {
    
    // 1. STRATEGY A: Direct Reply (Swipe Right)
    // We check if the message ID they replied to exists in our 'vendor_requests' table.
    const replyId = msg?.message?.extendedTextMessage?.contextInfo?.stanzaId;
    if (replyId) {
        const directMatch = getContextBySentMsgId(replyId);
        if (directMatch) {
            return 'VENDOR_REPLY'; // ✅ Valid Reply found in DB
        }
    }

    // 2. STRATEGY B: Active Session (Fallback)
    // If they didn't swipe right, we check if we are currently WAITING for a reply from them.
    const vendorId = msg?.key?.remoteJid;
    if (vendorId) {
        const activeMatch = getLastActiveRequest(vendorId);
        if (activeMatch) {
            return 'VENDOR_REPLY'; // ✅ Found an open ticket for this vendor
        }
    }

    // ❌ If neither match found, it's just random chatter. Ignore it.
    return 'IGNORE';
  }

  return 'IGNORE';
}

module.exports = {
  classifyMessage,
  looksLikeQuery // exported for safety/debug if needed
}
