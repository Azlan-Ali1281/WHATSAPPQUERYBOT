const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason // 👈 ADD THIS HERE
} = require('@whiskeysockets/baileys')
const { processLocalRates } = require('./v2/localRateEngine');

let isReconnecting = false; // 🛡️ THE LOCK

const { initDatabase } = require('./database');
const qrcode = require('qrcode-terminal');

const { updateTiers, getCurrentTiers } = require('./v2/markupEngine');
const { 
    createParentQuery,
    getLastActiveRequest, 
    createChildQuery, 
    logVendorRequest,
    getContextBySentMsgId, // 👈 ADD THIS
    saveVendorQuote, 
    updateRequestStatus, // 👈 ADD THIS
    recallLastParentQueries, // 👈 ADD THIS
    recallLastChildQueries,   // 👈 ADD THIS
    getQuoteByReqId,
    isEmployeeDB, // 👈 ADD THIS
    getClientLimits,        // 👈 NEW
    setClientLimits,        // 👈 NEW
    getDailyQueryCount, // 👈 ADD THIS
    getGroupRoleDB,         // 👈 NEW
    getOwnerGroupsDB,       // 👈 NEW
    getVendorsForHotelDB,   // 👈 NEW
    getClientCodeDB         // 👈 NEW
} = require('./database');

// ✅ CORRECT (Relative to index.js)
const { calculateQuote } = require('./v2/calculator');
const { formatForOwner } = require('./v2/formatter');

const { segmentClientQuery } = require('./aiBlockSegmenter')
const { parseClientMessageWithAI } = require('./aiClientParser')
const { classifyMessage } = require('./messageClassifier')
const { sanitizeHotelNames } = require('./aiSanitizer');


const {
  createParent,
  getParent,
  createChild,
  getOpenChildren,
  addVendorReply,
  linkVendorMessage,
  getChildByVendorMessage,
  setPendingQuestion,   // ✅ Import for Conversational Repair
  clearPendingQuestion  // ✅ Import for Conversational Repair
} = require('./queryStore')

const { formatQueryForVendor } = require('./queryFormatter')
const { findMatchingChild } = require('./vendorMatcher')

const autoQuoter = require('./v2/autoQuoter');

const { isSimpleRate } = require('./vendorRateClassifier')
const { calculateSimpleRate } = require('./vendorRateLogic')
const { calculateComplexRate } = require('./vendorRateAI')
const { checkSavedRate } = require('./rateStore');

const VENDOR_SEND_DELAY_MS = 2000
const RESPONSE_DELAY_MS = 20000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ======================================================
// 🔒 PRODUCTION MVP FLAG
// ======================================================
const PRODUCTION_MVP_MODE = true

let globalSock = null;
let globalQR = null;
let globalBotStatus = 'INITIALIZING'; // Tracking state for the frontend
const fs = require('fs'); // Required to delete the auth folder
const path = require('path');

// ==========================================
// 🏨 AUTO-SETUP HOTEL REGISTRY DATABASE
// ==========================================
const dbRef = require('./database').getDatabase();
dbRef.prepare(`
    CREATE TABLE IF NOT EXISTS hotel_registry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
    )
`).run();

// Seed it with the original list ONLY if it's completely empty
const registryCount = dbRef.prepare(`SELECT COUNT(*) as count FROM hotel_registry`).get().count;
if (registryCount === 0) {
    const initialHotels = [
        "Anwar Al Madinah", "Saja Al Madinah", "Saja Makkah","Pullman Zamzam Madinah", "Madinah Hilton", "Safwa Tower","Grand Plaza Almadina", "Shahd Al Madinah", "The Oberoi Madina", "Dar Al Taqwa", "Dar Al Eiman Intercontinental", "Grand Plaza Badr Al Maqam", "Dar Al Hijra InterContinental", "Movenpick Madinah", "Crowne Plaza Madinah", "Plaza Inn Ohud","Maysan Altaqwa", "Leader Al Muna Kareem", "Odst Al Madinah", "Artal International", "Zowar International", "Taiba Front", "Al Aqeeq", "Frontel Al Harithia", "Dallah Taibah", "Golden Tulip Al Zahabi", "Al Mukhtara International", "Al Haram Hotel", "Sky View","Province Al Sham", "Taif Al Nebras" , "Gulnar Taiba", "Emaar Al Manar","Bir Al Eiman","Tara Al Hijra","Rama Al Madinah","Miramar","Arkan Almanar","Maysan Rehab Elmysk", "Fairmont Makkah Clock Royal Tower", "Swissotel Makkah", "Swissotel Al Maqam", "Raffles Makkah Palace", "Pullman Zamzam Makkah", "Movenpick Hajar Tower", "Al Marwa Rayhaan by Rotana", "Makkah Hotel", "Makkah Towers","Time Ruba","Shaza Regency","Land Prenium","Taiba Madinah", "Hilton Makkah Convention", "Hilton Suites Makkah", "Hyatt Regency Makkah", "Conrad Makkah", "Jabal Omar Marriott", "Saif Al Majd","Address Jabal Omar", "Sheraton Makkah Jabal Al Kaaba", "DoubleTree by Hilton Makkah", "Le Meridien Makkah", "Waqf Uthman", "Safwat Al Medina","Courtyard By Marriott", "Courtyard By Marriot", "Courtyard Makkah", "Courtyard Madinah","Mira Sud","majd al muhajireen","Maden Madinah","Zila Al Nazula","Anjum Makkah", "Voco Makkah", "Kiswa Towers", "Elaf Ajyad", "Le Meridien Towers Makkah", "Holiday Inn","Worth Peninsula", "Novotel Makkah Thakher City", "Holiday Inn Makkah Al Aziziah", "Triple One" ,"Four Points by Sheraton Makkah", "Emaar Grand Makkah", "Emaar Elite Makkah"
    ];
    const insertHotel = dbRef.prepare(`INSERT OR IGNORE INTO hotel_registry (name) VALUES (?)`);
    dbRef.transaction(() => { initialHotels.forEach(h => insertHotel.run(h)); })();
    console.log("✅ Successfully seeded the new Hotel Registry database.");
}
// ======================================================
// 👑 OWNER COMMAND HANDLER (Recall/Delete)
// ======================================================
async function handleOwnerDeleteCommand(sock, msg, text) {
    const groupId = msg.key.remoteJid;
    // Matches: "/bot del p1", "/bot Del C5", etc.
    const match = text.match(/^\/bot\s+del\s+([pc])(\d+)$/i);
    
    if (!match) {
        await sock.sendMessage(groupId, { text: "❌ Invalid Command.\nUse: */bot Del P1* (Parents) or */bot Del C2* (Children)" }, { quoted: msg });
        return;
    }

    const type = match[1].toUpperCase(); // 'P' or 'C'
    const count = parseInt(match[2], 10);

    if (count < 1 || count > 20) {
        await sock.sendMessage(groupId, { text: "⚠️ You can only delete between 1 and 20 queries at a time to prevent rate limits." }, { quoted: msg });
        return;
    }

    await sock.sendMessage(groupId, { text: `⏳ Recalling last ${count} ${type === 'P' ? 'Parent' : 'Child'} queries and deleting vendor messages...` }, { quoted: msg });

    try {
        let result;
        // Assuming these functions return an object like: { pDeleted: 0, cDeleted: 0, messages: [] }
        if (type === 'P') result = recallLastParentQueries(count);
        else result = recallLastChildQueries(count);

        // 🛑 SAFETY CHECK 1: Did the database actually return anything?
        if (!result || (type === 'P' && result.pDeleted === 0) || (type === 'C' && result.cDeleted === 0)) {
            await sock.sendMessage(groupId, { text: "📭 *No queries found!* The database is already clean." }, { quoted: msg });
            return; // Stop the function here so it doesn't crash
        }

        let delCount = 0;
        
        // 🛑 SAFETY CHECK 2: Ensure 'messages' exists and is an array before looping
        if (result.messages && Array.isArray(result.messages) && result.messages.length > 0) {
            for (const m of result.messages) {
                // Skip if missing crucial data
                if (!m.vendor_group_id || !m.sent_message_id) continue; 

                try {
                    await sock.sendMessage(m.vendor_group_id, { 
                        delete: { remoteJid: m.vendor_group_id, fromMe: true, id: m.sent_message_id } 
                    });
                    delCount++;
                    
                    // Wait 300ms between deletes so WhatsApp doesn't block the bot
                    await new Promise(resolve => setTimeout(resolve, 300)); 
                } catch (e) {
                    console.log(`⚠️ Failed to delete msg in ${m.vendor_group_id}`);
                }
            }
        }

        // Generate the final accurate report
        const report = type === 'P' 
            ? `✅ *RECALL COMPLETE*\n\n🗑️ Deleted ${result.pDeleted} Parent Queries\n🗑️ Deleted ${result.cDeleted} Child Queries\n💬 Recalled ${delCount} Vendor Messages.`
            : `✅ *RECALL COMPLETE*\n\n🗑️ Deleted ${result.cDeleted} Child Queries\n💬 Recalled ${delCount} Vendor Messages.`;

        await sock.sendMessage(groupId, { text: report }, { quoted: msg });

    } catch (err) {
        console.error("Recall Error:", err);
        await sock.sendMessage(groupId, { text: "❌ Code error during deletion check your console." }, { quoted: msg });
    }
}

function extractRoomTypesFromText(text = '') {
  const t = text.toUpperCase();
  const types = [];

  // 1. 👑 SPECIALTY / MODIFIED TYPES (Priority)
  const modifiers = "LARGE|SMALL|DIPLOMATIC|EXECUTIVE|ROYAL|RESIDENTIAL|PRESIDENTIAL|DELUXE|CLUB|JUNIOR|SENIOR|PANORAMA|GRAND|PREMIER|FAMILY|STUDIO|BUSINESS";
  const baseTypes = "SINGLE|DOUBLE|DBL|TWIN|TRIPLE|TRP|TPL|QUAD|QUINT|SUITE|ROOM|BED";
  
  const complexRegex = new RegExp(`\\b(${modifiers})\\s+(${baseTypes})(?:S?)\\b`, 'gi');
  let m;
  while ((m = complexRegex.exec(t)) !== null) {
    types.push(m[0]); 
  }

  // 2. 🛡️ PAX / PERSON / GUEST MAPPING
  // 🛡️ FIX: Added \s* to handle "2PAX" and "2 PAX"
  const paxPatterns = [
    { reg: /(?:\b|\d)\s*(1\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE|BED|BEDS|PPL|PEOPLES))\b/i, type: 'SINGLE' },
    { reg: /(?:\b|\d)\s*(2\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE|BED|BEDS|PPL|PEOPLES))\b/i, type: 'DOUBLE' },
    { reg: /(?:\b|\d)\s*(3\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE|BED|BEDS|PPL|PEOPLES))\b/i, type: 'TRIPLE' },
    { reg: /(?:\b|\d)\s*(4\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE|BED|BEDS|PPL|PEOPLES))\b/i, type: 'QUAD' },
    { reg: /(?:\b|\d)\s*(5\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE|BED|BEDS|PPL|PEOPLES))\b/i, type: 'QUINT' }
  ];

  paxPatterns.forEach(p => {
    if (p.reg.test(t)) types.push(p.type);
  });

// 3. 🏠 STANDARD TYPES & SHORTHAND (Updated for 2TRP/2DBL)
  // We check for: Start of line OR Non-Letter OR Digit
  const start = /(?:^|[^A-Z0-9]|\d)/i; 
  const end = /(?:$|[^A-Z0-9])/i;

  if (new RegExp(start.source + "SINGLE(?:S?)" + end.source, "i").test(t)) types.push('SINGLE');
  if (new RegExp(start.source + "(DBL|DOUBLE|DUBLE|TWIN)(?:S?)" + end.source, "i").test(t)) types.push('DOUBLE');
  if (new RegExp(start.source + "(TPL|TRP|TRIPLE|TRIPPLE|TRIPAL)(?:S?)" + end.source, "i").test(t)) types.push('TRIPLE'); 
  if (new RegExp(start.source + "(QUAD|QUARD|QAD|QUADR|QD|QUED)(?:S?)" + end.source, "i").test(t)) types.push('QUAD'); 
  if (new RegExp(start.source + "(QUINT|QUINTU|QUINTUPLE)(?:S?)" + end.source, "i").test(t)) types.push('QUINT');
  
  if (/\b(SUITE|ROOM|BED)(?:S?)\b/i.test(t)) {
     if (t.includes('SUITE')) types.push('SUITE');
  }

  return [...new Set(types)];
}

// 🛠️ HELPER: Date Normalizer (Robost Multi-Line Merger)
// 🛠️ HELPER: Date Normalizer (Gap-Jumping Version)
function normalizeMultiLineDateRange(text = '') {
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  
  // Regex to capture strictly the date part
  const dReg = /^(\d{1,2}(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)/i;
  
  for (let i = 0; i < lines.length - 1; i++) {
    // 1. Check Current Line
    const cleanL1 = lines[i].replace(/^(check\s*[-]?\s*(in|out|inn|date)|arr|dep|from|to)[:\s-]*/i, '').trim();
    const m1 = cleanL1.match(dReg);

    if (!m1) continue;

    // 2. Look Ahead (Next Line OR Line After Next)
    // We allow a "gap" of 1 line if it's just a separator (like "to", "-", "check out")
    let j = i + 1;
    let cleanL2 = lines[j].replace(/^(check\s*[-]?\s*(in|out|inn|date)|arr|dep|from|to)[:\s-]*/i, '').trim();
    let m2 = cleanL2.match(dReg);

    // If next line is NOT a date, check if it's a separator, then look at i+2
    if (!m2 && j + 1 < lines.length) {
        const isSeparator = /^(to|and|-|check\s*out|until|thru|through)$/i.test(lines[j]) || lines[j].length < 4;
        if (isSeparator) {
            j = i + 2; // Jump gap
            cleanL2 = lines[j].replace(/^(check\s*[-]?\s*(in|out|inn|date)|arr|dep|from|to)[:\s-]*/i, '').trim();
            m2 = cleanL2.match(dReg);
        }
    }

    // 3. Merge if found
    if (m1 && m2) {
       lines[i] = `${m1[1]} to ${m2[1]}`;
       
       // Clear consumed lines
       for (let k = i + 1; k <= j; k++) {
           lines[k] = ''; 
       }
       i = j; // Skip iterator
    }
  }
  return lines.filter(Boolean).join('\n');
}

function extractMeal(text = '') {
  const t = text.toUpperCase();
  
// 🌙 RAMADAN MEALS (Combo First!)
  if (/\b(SUHOOR|SEHRI).+(IFTAR|AFTARI)\b/.test(t) || /\b(IFTAR|AFTARI).+(SUHOOR|SEHRI)\b/.test(t)) {
      return 'SUHOOR + IFTAR';
  }

  // Handles: Suhoor, Sehri, Sahri, Iftar, Iftari, Aftari
  if (/\b(SUHOOR|SUHUR|SEHRI|SAHRI|SEHRY|SOHOR)\b/.test(t)) return 'SUHOOR';
  if (/\b(IFTAR|IFTARI|AFTARI|IFTAAR)\b/.test(t)) return 'IFTAR';
  
  // 🏨 STANDARD MEALS
  if (/\b(BB|BREAKFAST|BF)\b/.test(t)) return 'BB';
  if (/\b(RO|ROOM ONLY|ROOMONLY|ONLY ROOM|ROOMONLEY)\b/.test(t)) return 'RO';
  if (/\b(HB|HALF BOARD|HALFBOARD)\b/.test(t)) return 'HB';
  if (/\b(FB|FULL BOARD|FULLBOARD)\b/.test(t)) return 'FB';
  
  return '';
}

// ======================================================
// 🔒 JUNK LINE DETECTOR
// ======================================================
function isJunkLine(line) {
  const t = line.toLowerCase();
  
  // 🛡️ THE FIX: Removed 'view', 'kabah', 'haram', 'suhoor', 'iftar', 'sharing', 'person'.
  // These are handled intelligently by the Attribute Shield now so they don't accidentally
  // nuke real hotel names like "Sky View" or "Haramain".
  const junkKeywords = [
    'cheap', 'best', 'rates', 'price', 'check', 'kindly', 
    'please', 'offer', 'available', 'available?', 'base', 'net',
    'salam', 'waalaikum', 'assalam', 'hello', 'hi', 'dear', 
    'respected', 'greetings', 'thank', 'thanks', 'regards', 'wishes'
  ];
  
  // We use word boundaries (\b) so "price" doesn't accidentally trigger inside another word
  return junkKeywords.some(word => new RegExp(`\\b${word}\\b`, 'i').test(t));
}

function extractView(text = '') {
  const t = text.toLowerCase();
  
  // 🕌 PREMIER / PRIME / FULL HARAM & KAABA
  // Matches: premier, prime, prm, full, fl
  const isPremier = /\b(premier|preimer|prime|prm|full|fl)\b/.test(t);

  // 🕋 KAABA PATTERNS
  // Matches: kaaba, kaba, kabah, kbah, kabba, kabaa
  const kaabaPattern = /\b(ka+ba+h?|kbah)\b/;

  // 🕌 HARAM PATTERNS
  // Matches: haram, harem, harum, horm, hrm, hrm view
  const haramPattern = /\b(har[aeu]m|horm|hrm)\b/;

  // 🌓 PARTIAL / SIDE VIEWS
  // Matches: partial, part, prtl, side, sd, semi, smi, half
  const isPartial = /\b(partial|part|prtl|side|sd|semi|smi|half)\b/.test(t);

  // DETECTION LOGIC
  if (kaabaPattern.test(t)) {
      if (isPartial) return 'PARTIAL KAABA VIEW';
      if (isPremier) return 'PREMIER KAABA VIEW';
      return 'KAABA VIEW';
  }

  if (haramPattern.test(t)) {
      if (isPartial) return 'PARTIAL HARAM VIEW';
      if (isPremier) return 'PREMIER HARAM VIEW';
      return 'HARAM VIEW';
  }

  if (/\b(city|st|street|cty|back|bck|rd|road)\b/.test(t)) return 'CITY VIEW';
  
  return '';
}

// 🛠️ HELPER: DATE FORMATTING
// 🛠️ HELPER: DATE FORMATTING
function formatDateRange(checkIn, checkOut, label = null) {
    if (label) return label; // 👑 Return special label if exists (e.g. "LAST ASHRA")

    try {
        const d1 = new Date(checkIn);
        const d2 = new Date(checkOut);
        const opts = { day: 'numeric', month: 'short' };
        return `${d1.toLocaleDateString('en-GB', opts)} - ${d2.toLocaleDateString('en-GB', opts)}`;
    } catch (e) {
        return `${checkIn} to ${checkOut}`;
    }
}

// ======================================================
// 🔒 DOUBLE TREE PROTECTION
// ======================================================
function protectDoubleTreeHotel(text = '') {
  return text
    .replace(/\bDBL\s+TREE\b/gi, 'DOUBLETREE')
    .replace(/\bDOUBLE\s+TREE\b/gi, 'DOUBLETREE')
    .replace(/\bDUBLE\s+TREE\b/gi, 'DOUBLETREE')
    .replace(/\bTRIPLE\s+ONE\b/gi, 'TRIPLEONE');
}

// ======================================================
// 🔒 NORMALIZE SLASH DATE (22/24 feb)
// ======================================================
function normalizeSlashDateRange(text = '') {
  return text.replace(
    /(\d{1,2})\s*\/\s*(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi,
    '$1 to $2 $3'  // ✅ Output: "04 to 08 mar" (Removed the extra month)
  )
}

// ======================================================
// 🔒 ROOM WORD GUARD (Stricter Number Check)
// ======================================================
function isRoomOnlyLine(line = '') {
  const t = line.trim().toLowerCase();
  if (!t) return true;

  // 🛡️ 0. WHITELIST: If it has a Hotel Brand, it is VALID (Return false to keep it)
  // 🛡️ FIX: Added "towers" explicitly to protect plural hotel names
  const hotelBrands = /\b(hilton|swiss|voco|pullman|anwar|saja|kiswa|tower|towers|hotel|saif|majd|movenpick|fairmont|rotana|emaar|dar|tawhid|conrad|sheraton|marriott|le meridien|clock|royal|majestic|safwah|ghufran|shaza|millennium|copthorne|taiba|front|aram|artal|zn|fundaq|grand|oberoi|miramar|hidayah|hidaya|manar|iman|harmony|leader|mubarak|wissam|concord|vision|ruve|nozol|diafa|shourfah)\b/i;
  
  // 🚨 CRITICAL FIX: "LAST ASHRA" is a DATE, NEVER a hotel.
  // We check this BEFORE the whitelist so Emaar doesn't save it.
  if (/last\s*ashra|ramadan/i.test(t)) return true;
  if (/^(hotel\s*(mak|med|makkah|madina|madinah))[:\s-]*/i.test(t)) return true;

  if (hotelBrands.test(t)) return false;

  // 🛡️ 1. NUMBER START GUARD (Fixes "1 dbl with extra bed")
  // Added: qued
    if (/^\d/.test(t) && /(?:^|\d)(dbl|double|trp|triple|quad|qued|quint|bed|pax|room|guest|night|sharing|person|persons)\b/i.test(t)) {
      return true;
  }

  // 2. DATES
  if (/(\d{1,2})[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true;
  
  // 🚨 FATAL BUG FIX: Added \b word boundaries so "to" doesn't trigger on words like "towers"
  if (/\b(check\s*(in|out)|arr|dep|from|to)\b/i.test(t)) return true;

  // 3. KEYWORD DICTIONARY
  // Added: qued
  // Added: person (singular)
  // Updated with new view keywordsconst 
  roomLock = /\b(single|double|dbl|twin|triple|trp|tripple|quad|qued|quard|quart|qad|qud|quadr|quint|hex|hexa|suite|room|rooms|persons|person|bed|beds|view|veiw|vew|city|st|street|cty|back|bck|haram|harem|hrm|kaaba|kaba|kbah|partial|part|prtl|side|sd|semi|smi|fl|full|ro|bb|hb|fb|breakfast|extra|sharing|ex|ext|hv|kv|cv|wd|we|sr)\b/i;
  if (t.split(/\s+/).length === 1 && roomLock.test(t)) return true;

  const words = t.split(/\s+/);
  const isAllKeywords = words.every(w => 
      roomLock.test(w) || 
      /^\d+$/.test(w) || 
      /\b(guest|name|contact|pax|attn|with)\b/i.test(w) || 
      /^[:.-]+$/.test(w) ||
      w.length < 2 
  );

  return isAllKeywords;
}

// ======================================================
// 🔒 PURE DATE LINE DETECTOR
// ======================================================
function isPureDateLine(text = '') {
  const t = text.trim().toLowerCase()
    .replace(/^(check\s*(in|out|inn|date)|arr|dep|arrival|departure|from|to)[:\s-]*/i, '')
    .trim();

  if (!t) return false;
  
  // 🛡️ SPECIAL DATE: LAST ASHRA
  if (/last\s*ashra/i.test(t)) return true;

  // Supports "9th Apri", "25th March", "5 mar", "10 Marc"
  const datePattern = /^\d{1,2}(?:st|nd|rd|th)?[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i;
  return datePattern.test(t);
}

// ======================================================
// 🔒 HOTEL NORMALIZATION
// ======================================================
function normalizeHotelForAI(hotel = '') {
  let h = hotel.trim();
  if (!h || h.toLowerCase() === 'similar') return null;

// 🛡️ FIX: Address & Zip Code Cleaner (Don't delete the whole line!)
  // Old: if (/\b\d{5}\b/.test(h)) return null;
  // New: Remove the zip code, keep the hotel.
  h = h.replace(/\b\d{5}\b/g, '').trim(); 
  
  // Clean address parts
  if (/^(makkah|madinah|saudi arabia|street|road|district|jabal omar ibrahim al khalil)$/i.test(h)) return null;

  // ============================================================
  h = h.replace(/\b(double|dbl)\s*tree\b/gi, 'DoubleTree');
  h = h.replace(/\b(triple|trp)\s*(one|1)\b/gi, 'TripleOne');
  h = h.replace(/\b(fundaq|fudnaq)\b/gi, '');

  // 🛡️ 1. HARD BLOCK: Hallucinations (Dates/Filler)
  // Added: ashra
// 🛡️ 1. HARD BLOCK: Hallucinations (Dates/Filler/Distances)
  const badPatterns = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|tripl|oct|nov|dec|again|check|chk|plz|please|pax|room|triple|quad|double|booking|nights|date|ashra|meter|meters|distance|near)\b/i;
  if (badPatterns.test(h)) return null;

  // Kill tiny words like "IN" or "OUT" that might sneak past word boundaries
  if (/^(in|out|any|n\/a|unknown)$/i.test(h)) return null;

  // 🛡️ 2. DATE & NUMBER BLOCKER
  if (/^\d{1,2}[\/\-]\d{1,2}/.test(h)) return null;
  if (/^[\d\s\-\/\.]+$/.test(h)) return null;
  if (h.length < 3) return null;
  if (/^hotel$/i.test(h)) return null;

  // 🛡️ 4. HOTEL KEYWORD LIST
  // Added: hidayah (variations), concord, vision, jiwar, wahba, shourfah, etc.
  // 🛡️ 4. HOTEL KEYWORD LIST
  // Added: hidayah (variations), miramar, ruve, nozol, etc.
  const hotelKeywords = /\b(hotel|inn|suites|lamar|emaar|jabal|tower|towers|palace|movenpick|hilton|rotana|front|manakha|nebras|view|residence|grand|plaza|voco|sheraton|accor|pullman|anwar|dar|taiba|saja|emmar|andalusia|royal|shaza|millennium|ihg|marriott|fairmont|clock|al|bakka|retaj|rawda|golden|tulip|kiswa|kiswah|khalil|safwat|madinah|convention|tree|doubletree|tripleone|fundaq|bilal|elaf|kindi|bosphorus|zalal|nuzla|matheer|artal|odst|zowar|miramar|ruve|nozol|diafa|shourfah|manar|iman|harmony|leader|mubarak|wissam|concord|vision|hidayah|hidaya|hedaya)\b/i;
  // 🛡️ NOISE CLEANER
// Added: qued
  h = h.replace(/\b(single|double|dbl|twin|triple|trp|tripple|quad|qued|quard|room|only|tripl|bed|breakfast|bb|ro)\b/gi, '').trim();

  const words = h.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  // 1-WORD CHECK
  if (words.length === 1) {
    const isBrand = hotelKeywords.test(h);
    const isCode = /^[A-Z]{3,10}$/.test(h);
    if (!isBrand && !isCode) return null; 
  }

  // 🛡️ GUEST NAME BLOCKER
  const guestIndicators = /\b(mr|mrs|ms|guest|name|lead|contact|pax|attn|attention|ali|ahmed|muhammad|hussain|khan|paras|kayani)\b/i;
  if (words.length >= 2 && guestIndicators.test(h) && !hotelKeywords.test(h)) return null;

  if (/^[A-Z]{3,7}$/.test(h)) return `Hotel ${h}`;

  return h;
}
// ======================================================
// 🚀 BOT START
// ======================================================
async function startBot() {
  // Change this line:
const { state, saveCreds } = await useMultiFileAuthState('./auth_main') // 🛡️ NEW FOLDER NAME
  const { version } = await fetchLatestBaileysVersion()

// ... inside your startBot() function ...

const sock = makeWASocket({
    auth: state,
    version,
    browser: ["Windows", "Chrome", "110.0.0"], // Revert to standard Windows to avoid mobile-to-mobile bugs
    
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false, // 👈 STOPS heavy processing
    
    // Give the socket maximum breathing room during the initial flood
    connectTimeoutMs: 120000,
    keepAliveIntervalMs: 30000, 
    
    getMessage: async (key) => { return { conversation: 'HBA_Bot' } }
});

globalSock = sock;

// 🛡️ SURGICAL FIX: Drop heavy history payloads instantly
sock.ev.on('messaging-history.set', () => {
    console.log('🗑️ History sync detected and PURGED to prevent Termux memory crash.');
});
sock.ev.on('creds.update', saveCreds);

// 🛡️ SURGICAL FIX 2: Reconnection & Delayed Sync
// 🛡️ SURGICAL FIX 2: Reconnection & Delayed Sync
sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // 🟢 PASS QR TO FRONTEND DASHBOARD
    if (qr) {
        globalQR = qr; 
        globalBotStatus = 'NEEDS_SCAN';
        console.log('\n📱 SCAN QR CODE:\n');
        qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
        globalBotStatus = 'DISCONNECTED'; // 🔴 TELL DASHBOARD WE LOST CONNECTION
        
        if (isReconnecting) return; 
        isReconnecting = true; 

        // 🛡️ Safe Error Parsing
        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode || error?.output?.payload?.statusCode || 500;
        
        // 🛡️ DO NOT RECONNECT IF LOGGED OUT INTENTIONALLY
        if (statusCode === DisconnectReason.loggedOut) {
            console.log('❌ Device logged out. Please delete the auth folder and scan again.');
            isReconnecting = false;
            globalBotStatus = 'LOGGED_OUT'; // 🔴 TELL DASHBOARD WE ARE LOGGED OUT
            return;
        }

        const needsLongWait = [428, 440, 503, 515, 408].includes(statusCode);
        const waitTime = needsLongWait ? 30000 : 5000;
        
        console.log(`❌ Connection Error ${statusCode}. Retrying in ${waitTime/1000}s...`);
        
        // 🛡️ THE CLEAN KILL: Destroy the old socket properly
        if (globalSock) {
            globalSock.ev.removeAllListeners();
            try {
                 globalSock.ws.close(); 
            } catch (e) {
                 // Ignore errors if the socket is already dead
            }
            globalSock = null;
        }

        // 🛡️ THE WAIT
        setTimeout(() => {
            console.log("🔄 Attempting to reconnect now...");
            isReconnecting = false; 
            startBot();
        }, waitTime);

    } else if (connection === 'open') {
        globalQR = null;               // 🟢 CLEAR DASHBOARD QR
        globalBotStatus = 'CONNECTED'; // 🟢 TELL DASHBOARD WE ARE ONLINE
        isReconnecting = false; 
        console.log('✅ Bot Connected. ACCOUNT RECOVERY MODE: Standing by for 5 minutes...');
    }
});

sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message || msg.key.fromMe) return;

        const senderId = msg.key.participant || msg.key.remoteJid;
        const groupId = msg.key.remoteJid;
        const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

        // 1. Only process messages inside WhatsApp Groups
        const isGroup = groupId.endsWith('@g.us');
        if (!isGroup || !rawText) return; 

        // 2. Fetch current group status from database
        const { getGroupInfo, registerUnknownGroup } = require('./database');
        let groupInfo = getGroupInfo(groupId);

        // =========================================================
        // 🌟 NEW: AUTO-REGISTER UNKNOWN GROUPS
        // =========================================================
        if (!groupInfo) {
            try {
                // Ask WhatsApp for the Group Name
                const metadata = await sock.groupMetadata(groupId);
                const groupName = metadata.subject || "Unnamed Group";
                
                // Save to database as 'UNKNOWN'
                registerUnknownGroup(groupId, groupName);
                
                // Re-fetch the info so the bot knows it exists now
                groupInfo = getGroupInfo(groupId); 
            } catch (err) {
                console.error(`⚠️ Failed to fetch group metadata for ${groupId}:`, err.message);
                return; // Stop processing if WhatsApp refuses to give us the group info
            }
        }

        // =========================================================
        // 3. Role Verification (The Gatekeeper)
        // =========================================================
        
        // If it's an UNKNOWN group, ignore all messages until Admin assigns a role
        if (!groupInfo || groupInfo.role === 'UNKNOWN') return;

        const role = groupInfo.role;
        const isClient = role === 'CLIENT';
        const isVendor = role === 'VENDOR';

        // ... [The rest of your existing logic (Owner commands, Client Queries, Vendor Replies) continues below here] ...

// ======================================================
    // 🚀 NEW COMMAND: /send (Forward Quote to Client)
    // ======================================================
    if (rawText.toLowerCase().startsWith('/send')) {
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        const quotedMsg = contextInfo?.quotedMessage?.extendedTextMessage?.text || 
                          contextInfo?.quotedMessage?.conversation;
                          
        // ⚠️ ERROR CHECK: Did they actually reply to a message?
        if (!quotedMsg) {
            await sock.sendMessage(groupId, { text: '⚠️ You must *reply* directly to a V2 Shadow Report message to use /send.' }, { quoted: msg });
            return;
        }

        // ⚠️ ERROR CHECK: Is it a valid report with a Ref ID?
        // 🛡️ FIX: Look specifically for "RQ-123" to bypass WhatsApp bold formatting
        const refMatch = quotedMsg.match(/RQ-(\d+)/);
        if (!refMatch) {
            await sock.sendMessage(groupId, { text: '⚠️ Could not find the Ref ID. Make sure you are replying to the full V2 bot report.' }, { quoted: msg });
            return;
        }

        const reqId = refMatch[1];
        const parts = rawText.trim().split(/\s+/);
        let modifier = 0;
        
        // Check for +20 or -20
        if (parts.length > 1) {
            modifier = parseInt(parts[1]) || 0; 
        }

        // Fetch from Database
        const quoteData = getQuoteByReqId(reqId);
        
        if (quoteData) {
            const quote = JSON.parse(quoteData.full_json);
            const { buildClientMessage } = require('./v2/formatter');
            const finalMsg = buildClientMessage(quote, modifier);
            
            // 🛡️ Build the perfect Baileys Quote Object for WhatsApp Web Compatibility
            const originalMessageQuote = {
                key: {
                    remoteJid: quoteData.client_group_id,
                    fromMe: false,                               // 👈 Required for WA Web
                    id: quoteData.client_msg_id,
                    participant: quoteData.client_participant    // 👈 Required for Group Replies
                },
                message: { 
                    conversation: quoteData.original_text || "Booking Request" 
                }
            };

            // 📤 Send directly to the client group AS A REPLY to their original query!
            await sock.sendMessage(quoteData.client_group_id, { 
                text: finalMsg 
            }, { 
                quoted: originalMessageQuote 
            });
            
            // ✅ Confirm success to the owner
            await sock.sendMessage(groupId, { 
                text: `✅ Sent to client successfully!\n📍 Group: ${quoteData.client_group_id}\n💰 Adjustment: ${modifier > 0 ? '+' : ''}${modifier} SAR/night` 
            }, { quoted: msg });
            
        } else {
            await sock.sendMessage(groupId, { text: '❌ Could not find this quote in the database.' }, { quoted: msg });
        }
        
        return; // 🛑 Stop processing so it doesn't fall down into IGNORE or CLIENT_QUERY
    }

    // ======================================================
    // 🕵️ ROLE ASSIGNMENT & ROUTING
    // ======================================================
    // ... your standard role checking (isOwner, isVendor, etc.) continues here ...
    // ======================================================
    // 🚀 NEW COMMAND: /send (Forward Quote to Client)
    // ======================================================
    if (rawText.toLowerCase().startsWith('/send')) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text || 
                          msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation;
                          
        if (quotedMsg) {
            const refMatch = quotedMsg.match(/Ref:\s*RQ-(\d+)/);
            if (refMatch) {
                const reqId = refMatch[1];
                const parts = rawText.split(' ');
                let modifier = 0;
                
                // Parse optional modifier like /send +20 or /send -20
                if (parts.length > 1) {
                    modifier = parseInt(parts[1]) || 0; 
                }

                const quoteData = getQuoteByReqId(reqId);
                if (quoteData) {
                    const quote = JSON.parse(quoteData.full_json);
                    
                    // 🛡️ SAFETY CHECK: Block old database quotes from crashing the bot
                    if (!quote.breakdown) {
                        await sock.sendMessage(groupId, { text: '❌ This quote uses an old database format and cannot be forwarded. Please generate a new quote.' }, { quoted: msg });
                        return;
                    }

                    const { buildClientMessage } = require('./v2/formatter');
                    const finalMsg = buildClientMessage(quote, modifier);
                    
                    // Reply directly to the original message in the client group
                    await sock.sendMessage(quoteData.client_group_id, { 
                        text: finalMsg 
                    }, { 
                        quoted: { 
                            key: { 
                                remoteJid: quoteData.client_group_id, 
                                id: quoteData.client_msg_id 
                            }, 
                            message: { conversation: "Original Query" } 
                        } 
                    });
                    
                    // Confirm in Owner Group
                    await sock.sendMessage(groupId, { text: `✅ Sent to client successfully! (Adjustment: ${modifier > 0 ? '+' : ''}${modifier} SAR/night)` }, { quoted: msg });
                } else {
                    await sock.sendMessage(groupId, { text: '❌ Could not find this quote in the database.' }, { quoted: msg });
                }
                return; // Stop processing this message further
            }
        }
    }
    // ============================================================
    // 👤 PRIVATE MESSAGE AUTO-REPLY
    // ============================================================
    // If it is NOT a group message (doesn't end in @g.us), it's a DM.
//     if (!groupId?.endsWith('@g.us')) {
//         // Only reply if they actually sent some text, to avoid spamming system events
//         if (rawText.trim()) {
//             const autoReply = `*Salam! 👋*

// Main HBA Travel & Tours ka B2B Umrah Query Bot hoon, jise HBA Group ne develop kiya hai. 

// *🤖 Main Kaisay Kaam Karta Hoon:*
// Jab koi client group mein Umrah hotel ki query bhejta hai, main AI aur rules ke zariye usay samajhta hoon. Phir usay format kar ke vendors ko bhejta hoon (ya saved rates ka direct reply karta hoon). Vendor ke reply aane par, main rates calculate aur compare kar ke final quote client ko bhej deta hoon.

// *⚠️ Status:* Main abhi development phase mein hoon, is liye agar koi issue aaye toh zaroor batayein.

// 📞 *Contacts:*
// • *Queries/Rates Issues:* Reservation Manager, Anas Ali  +923326873756 
// • *Bot Details/Bug Reports:* Developer, Azlan Ali  +923162724750 

// *(Main sirf designated groups mein kaam karta hoon aur direct messages ka reply nahi kar sakta. Shukriya!)*

// ---

// *Salam! 👋*

// I am the B2B Umrah Query Bot for HBA Travel & Tours, developed by HBA Group.

// *🤖 How I Work:*
// When a client sends a hotel query in the group, I use AI and custom rules to process it. I then format and forward it to relevant vendors (or instantly reply with saved rates). Once a vendor replies, I analyze, calculate, and compare the rates before sending the final quote back to the client.

// *⚠️ Status:* I am currently in the development phase, so you might encounter some minor issues. 

// 📞 *Contacts:*
// • *Queries/Rates Issues:* Reservation Manager, Anas Ali  +923326873756 
// • *Bot Info/Bug Reports:* Developer, Azlan Ali  +923162724750 

// *(I only operate inside designated WhatsApp groups and cannot process direct messages. Thank you!)*`;

//             await sock.sendMessage(groupId, { text: autoReply });
//         }
//         return; // Stop processing so it doesn't trigger the rest of the bot
//     }

    if (!rawText.trim()) return

    // ============================================================
    // 🛑 TRANSPORT & CAB BOOKING FILTER
    // ============================================================
    // If the message contains these specific transport keywords, ignore it completely.
    const isTransport = /\b(car\s*type|sector\s*[:\-]|time\s*of\s*pickup|ticket\s*detail|lead\s*pax\s*name)\b/i.test(rawText);
    if (isTransport) {
        console.log("🚕 Transport/Cab booking detected. Ignoring.");
        return; // Stops the bot from processing this message
    }


// ============================================================
    // 👑 COMMAND MODE: OWNER OVERRIDE (Bypasses Employee Check)
    // ============================================================
    // (Your existing /bot del command is here...)
    if (role === 'OWNER' && rawText.trim().toLowerCase().startsWith('/bot del')) {
        await handleOwnerDeleteCommand(sock, msg, rawText.trim());
        return; 
    }

    // 🚀 NEW COMMAND: /setmarkup (Dynamic Profit Margins)
    if (role === 'OWNER' && rawText.trim().toLowerCase().startsWith('/setmarkup')) {
        const parts = rawText.trim().split(/\s+/).slice(1);
        
        if (parts.length === 0) {
            const current = getCurrentTiers().map(t => `${t.threshold === Infinity ? 'MAX' : t.threshold} SAR = +${t.margin}`).join('\n');
            await sock.sendMessage(groupId, { text: `📊 *CURRENT MARKUP RULES:*\n${current}\n\n*Usage:* /setmarkup 500=20 1000=40 max=60` }, { quoted: msg });
            return;
        }

        const newTiers = [];
        for (const part of parts) {
            let [limit, margin] = part.split('=');
            if (!limit || !margin) continue;

            const parsedLimit = limit.toLowerCase() === 'max' ? Infinity : parseInt(limit, 10);
            const parsedMargin = parseInt(margin, 10);

            if (!isNaN(parsedMargin)) {
                newTiers.push({ threshold: parsedLimit, margin: parsedMargin });
            }
        }

        if (newTiers.length > 0) {
            // Ensure there is always a MAX fallback
            if (!newTiers.some(t => t.threshold === Infinity)) {
                newTiers.push({ threshold: Infinity, margin: newTiers[newTiers.length - 1].margin });
            }
            
            updateTiers(newTiers);
            
            const updated = getCurrentTiers().map(t => `${t.threshold === Infinity ? 'MAX' : t.threshold} SAR = +${t.margin}`).join('\n');
            await sock.sendMessage(groupId, { text: `✅ *MARKUP RULES UPDATED!*\n\n${updated}` }, { quoted: msg });
        } else {
            await sock.sendMessage(groupId, { text: `❌ Invalid format. Use: /setmarkup 500=20 1000=40 max=60` }, { quoted: msg });
        }
        return;
    }
// 🚀 NEW COMMANDS: /tier (Manage Limit Packages)
    if (role === 'OWNER' && rawText.trim().toLowerCase().startsWith('/tier')) {
        const parts = rawText.trim().split(/\s+/);
        const action = parts[1]?.toLowerCase(); 
        
        const { upsertLimitTier, assignTierToGroup } = require('./database');

        // COMMAND 1: Create/Update a Tier -> /tier set VIP daily=100 child=15 hotel=5
        if (action === 'set' && parts.length >= 3) {
            const tierName = parts[2].toUpperCase();
            
            // Start with defaults
            const limits = { max_daily_queries: 30, max_child_queries: 6, max_date_ranges: 3, max_room_types: 2, max_hotels_per_date: 4 };

            // Parse updates
            for (let i = 3; i < parts.length; i++) {
                const [key, val] = parts[i].split('=');
                const num = parseInt(val, 10);
                if (isNaN(num)) continue;

                if (key === 'daily') limits.max_daily_queries = num;
                if (key === 'child') limits.max_child_queries = num;
                if (key === 'date') limits.max_date_ranges = num;
                if (key === 'room') limits.max_room_types = num;
                if (key === 'hotel') limits.max_hotels_per_date = num;
            }

            upsertLimitTier(tierName, limits);
            await sock.sendMessage(groupId, { text: `✅ *TIER CREATED/UPDATED: [${tierName}]*\nDaily: ${limits.max_daily_queries} | Child/Msg: ${limits.max_child_queries} | Dates: ${limits.max_date_ranges} | Hotels: ${limits.max_hotels_per_date} | Rooms: ${limits.max_room_types}` }, { quoted: msg });
            return;
        }

// COMMAND 2: Assign Tier to Group -> /tier assign 31 VIP
        if (action === 'assign' && parts.length >= 4) {
            let targetInput = parts[2]; // This could be '31' or '120363...@g.us'
            const tierName = parts[3].toUpperCase();
            
            const { assignTierToGroup, getGroupIdByClientCode } = require('./database');
            
            let targetGroupId = targetInput;

            // If the input doesn't look like a WhatsApp ID, assume it's a short Client Code
            if (!targetInput.includes('@g.us')) {
                const resolvedId = getGroupIdByClientCode(targetInput);
                
                if (!resolvedId) {
                    await sock.sendMessage(groupId, { text: `❌ Could not find any client with the code: *${targetInput}*` }, { quoted: msg });
                    return;
                }
                targetGroupId = resolvedId;
            }
            
            assignTierToGroup(targetGroupId, tierName);
            await sock.sendMessage(groupId, { text: `✅ *TIER ASSIGNED!*\nClient: ${targetInput}\nGroup: ${targetGroupId}\nNow operating on the [${tierName}] package limits.` }, { quoted: msg });
            return;
        }

        await sock.sendMessage(groupId, { text: `❌ *Invalid Command*\n\n*To Create a Tier:*\n/tier set VIP daily=100 child=15 date=5 hotel=5\n\n*To Assign a Tier:*\n/tier assign 120363... VIP` }, { quoted: msg });
        return;
    }

    // 🚀 NEW COMMAND: /info [GroupId] (Checks Database Status)
// 🚀 NEW COMMAND: /info [GroupId or ClientCode] (Checks Database Status)
    if (role === 'OWNER' && rawText.trim().toLowerCase().startsWith('/info')) {
        const parts = rawText.trim().split(/\s+/);
        const targetInput = parts[1] || groupId; 
        
        const { getGroupInfo, getGroupIdByClientCode } = require('./database');
        
        let targetGroupId = targetInput;

        // If it doesn't look like a WhatsApp ID, assume it's a short Client Code
        if (!targetInput.includes('@g.us') && parts[1]) {
            const resolvedId = getGroupIdByClientCode(targetInput);
            
            if (!resolvedId) {
                await sock.sendMessage(groupId, { text: `❌ Could not find any client with the code: *${targetInput}*` }, { quoted: msg });
                return;
            }
            targetGroupId = resolvedId;
        }

        const info = getGroupInfo(targetGroupId);

        if (!info) {
            await sock.sendMessage(groupId, { text: `❌ Group not found in database.\nID: ${targetGroupId}` }, { quoted: msg });
            return;
        }

        let report = `📊 *DATABASE INFO*\n📍 *ID:* ${targetGroupId}\n📝 *Name:* ${info.name}\n🎭 *Role:* ${info.role}\n`;
        if (info.limit_tier) report += `💎 *Tier:* [${info.limit_tier}]\n`;

        if (info.role === 'CLIENT') {
            report += `🏷️ *Client Code:* ${info.client_code}\n`;
            report += `📈 *Usage Today:* ${info.daily_count} / ${info.limits.max_daily_queries} queries\n`;
            report += `⚙️ *Limits:*\n  - Child/Msg: ${info.limits.max_child_queries}\n  - Dates: ${info.limits.max_date_ranges}\n  - Hotels: ${info.limits.max_hotels_per_date}\n  - Rooms: ${info.limits.max_room_types}`;
        } 
        else if (info.role === 'VENDOR') {
            try {
                const hotels = JSON.parse(info.handled_hotels);
                report += `🏨 *Handled Hotels:*\n  - ${hotels.join('\n  - ')}`;
            } catch(e) {
                report += `🏨 *Handled Hotels:* Error reading data.`;
            }
        }

        await sock.sendMessage(groupId, { text: report }, { quoted: msg });
        return;
    }
    
    // Now it is safe to block employees from sending normal hotel queries
// 🛡️ Filter out messages from Internal Employees
    if (isEmployeeDB(senderId)) {
        console.log(`Ignoring message from employee: ${senderId}`);
        return;
    }

    // 🧠 CONVERSATIONAL REPAIR (Fixed)
    const { getPendingQuestion, clearPendingQuestion } = require('./queryStore');
    const pending = getPendingQuestion(groupId);
    let finalProcessingText = rawText;

    // 🛡️ SMART MERGER FIX: 
    // If the NEW message looks like a full query (has Month + Room), ignore pending questions!
    const looksLikeNewQuery = 
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(rawText) && 
        extractRoomTypesFromText(rawText).length > 0;

    if (pending && !looksLikeNewQuery) {
        console.log(`🔗 Merger: Found pending ${pending.missing}. Combining...`);
        finalProcessingText = `${pending.originalText}\n${rawText}`;
        clearPendingQuestion(groupId); 
    } else if (looksLikeNewQuery) {
        // User ignored the bot's question and asked something new -> Clear the memory
        clearPendingQuestion(groupId);
    }

    // ✅ PASS 'msg' SO CLASSIFIER CAN CHECK DATABASE
    const type = classifyMessage({ groupRole: role, text: finalProcessingText, msg: msg })
    const universalTypes = extractRoomTypesFromText(finalProcessingText);

    console.log('\n----------------------------')
    console.log('Group:', groupId)
    console.log('User ID:', senderId);
    console.log('Role:', role)
    console.log('Type:', type)
    console.log('Text:', finalProcessingText)

if (role === 'CLIENT' && type === 'CLIENT_QUERY') {
      
      // ============================================================
      // 🛑 SMART LIMITS: DAILY PARENT BLOCKER
      // ============================================================
      const clientLimits = getClientLimits(groupId);
      const dailyCount = getDailyQueryCount(groupId);
        if (dailyCount >= clientLimits.max_daily_queries) {
          console.log(`🚫 Daily limit reached for ${groupId} (${dailyCount}/${clientLimits.max_daily_queries})`);
          
          // 🛡️ Fetch friendly names for the owner alert
          const { getGroupInfo } = require('./database');
          const groupInfo = getGroupInfo(groupId);
          const displayName = groupInfo ? `${groupInfo.name} (${groupInfo.client_code})` : groupId;

          await sock.sendMessage(groupId, { 
              text: `⚠️ *Daily Limit Reached*\n\nYou have used your maximum of ${clientLimits.max_daily_queries} queries for today. Please wait until tomorrow or contact support for an upgrade.` 
          }, { quoted: msg });
          
          // Notify the owners with friendly names
          for (const owner of getOwnerGroupsDB()) {
              await sock.sendMessage(owner, { 
                  text: `🚦 *CLIENT CAPPED*\nClient: *${displayName}*\nHit their daily limit of *${clientLimits.max_daily_queries}* queries.` 
              });
          }
          return; 
      }      
      // ============================================================
      // 🛡️ 1. ROBUST PRE-PROCESSING
      // ============================================================
      // ✅ STEP A: Fix Typos & Normalize
      let preProcessedText = finalProcessingText
        // 🛡️ FIX 27-C: SMART SUFFIX REMOVER (Moved to the VERY TOP)
        .replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
        .replace(/\bof\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi, '$1')

        .replace(/(\d+)([a-zA-Z]+)/g, '$1 $2') // 👈 NEW: Turns "2trp" into "2 trp" and "3dbl" into "3 dbl"
        .replace(/\bcheck\s*inn\b/gi, 'check in') 
        .replace(/\bmeridian\b/gi, 'meridien') // 👈 THE TYPO FIX
        
        // 🛡️ FIX: Keep the words "in" and "out" but remove colons so dates anchor properly
        .replace(/\b(in|out|inn|date|arr|dep|from|to)\s*:\s*/gi, '$1 ')     
        .replace(/\b(guest|name)\s*:\s*/gi, 'guest ')

        // 🛡️ FIX 4: CHATTER CLEANER (Removed 'check' so date anchors survive)
        .replace(/\b(salam|bhai|hi|hello|dear|sir|madam|please|plz|kindly|need|want|booking|rates|price|prices|amount|cost)\b/gi, ' ')
        
// 🛡️ FIX 4.5: KILL "HOTEL MAK:" LABELS (Prevents them from becoming orphan hotels)
        .replace(/\bhotel\s*(mak|med|makkah|madina|madinah)\s*[:\-]?\s*/gi, '\n')
        
        // 🛡️ FIX 4.6: "OR SIMILAR" VAPORIZER 👈 ADD THIS NEW BLOCK!
        // Deletes client padding so "Land premium or similar" cleanly becomes "Land premium"
        .replace(/\b(or\s+similar|or\s+equivalent|and\s+similar|any\s+similar|similar)\b/gi, ' ')
        
        // 🛡️ FIX: KILL ZIP CODES (Prevents "Swiss 21955" from being deleted later)
        .replace(/\b\d{5}\b/g, ' ') 
        
        // 🛡️ FIX: KILL GENERIC TERMS (Prevents "Fundaq" from being seen as a hotel)
        .replace(/\b(fundaq|fudnaq)\b/gi, ' ')
        
        // Standardize to "LAST ASHRA" so the AI recognizes it easily
        .replace(/\b(last\s*ashra|last\s*10\s*days\s*of\s*ramadan|last\s*ashrah)\b/gi, 'LAST ASHRA')
        
        // 🛡️ FIX 27: COMPRESSED DATE NORMALIZER (e.g. 28mar-04apr -> 28 mar to 04 apr)
        .replace(/(\d{1,2})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi, '$1 $2')
        .replace(/(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\s*-\s*(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)/gi, '$1 to $2')

        // 🛡️ FIX 27-B: SMART DATE SPACER (The "11 April / 2011" Fix)
        .replace(/(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)(?:\s*\r?\n+\s*|\s+)(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)/gi, '$1 to $2')

        // 🛡️ FIX 26: HYPHEN DATE NORMALIZER
        .replace(/(\d{1,2})[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-]*(\d{2})\b/gi, '$1 $2 20$3')
        .replace(/(\d{1,2})[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-]*(\d{4})\b/gi, '$1 $2 $3')

        // 🛡️ FIX 27-D: SLASHED DATE CONVERTER (The "31/03/26" Fix)
        // Resolves DD/MM/YY to "31 Mar 2026" early so it doesn't get shredded by later rules
        .replace(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})\b/g, (m, d, mth, y) => {
             if (y.length === 2) y = "20" + y;
             const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
             const mIdx = parseInt(mth) - 1;
             return mIdx >= 0 && mIdx < 12 ? `${d} ${months[mIdx]} ${y}` : m;
        })

        // 🛡️ FIX 26-B: YEAR-ROOM SEPARATOR (Critical)
        // Turns "2026 TRIPLE" -> "2026 \n TRIPLE"
        // Prevents "2026" from being read as the room count.
        .replace(/\b(202[5-9])\s+(triple|quad|double|single|quint|room|bed|pax)/gi, '$1\n$2');

      // 🛡️ FIX 41: LAZY DATE MERGER
      preProcessedText = preProcessedText.replace(
          /\b(\d{1,2})\s+(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi,
          '$1 to $2 $3'
      );

      // 🛡️ FIX 7: THE HOTEL GRENADE (Refined)
      const brandsRegex = /\b(hilton|swiss|voco|pullman|anwar|saja|kiswa|movenpick|fairmont|rotana|emaar|dar|tawhid|conrad|sheraton|marriott|le meridien|clock|royal|majestic|safwah|shaza|millennium|oberoi|miramar|hidayah|hidaya|iman|harmony|leader|mubarak|wissam|concord|vision|ruve|nozol|diafa|shourfah)\b/gi;
      preProcessedText = preProcessedText.replace(brandsRegex, '\n$1');

      // 🛡️ FIX 8: THE EXPLODER
      preProcessedText = preProcessedText.replace(
          /(?<!\bto\s*)(?<!-\s*)(?<!\bfrom\s*)(\b\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)/gi, 
          '\n$1 '
      );
      
      // 🛡️ FIX 8-B: THE ROOM EXPLODER
      // Updated \s* to [ \t]* so it doesn't cross newlines and drag random numbers into room types
      preProcessedText = preProcessedText.replace(
          /(\b\d+[ \t]*(?:room|bed|pax|guest|dbl|double|trp|triple|quad|qued|quint|suite))/gi,
          '\n$1'
      );

      // ✅ STEP B: Run the Multi-Line Date Fixer
      preProcessedText = normalizeMultiLineDateRange(preProcessedText);

      // ✅ STEP C: Standard replacements
      preProcessedText = preProcessedText
        .replace(/(\d{1,2})\s*[\/-]\s*(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi, '$1 to $2 $3')
        
        // 🛡️ Swap 1: DD/MM/YYYY goes FIRST to prevent DD/MM from cannibalizing it
        .replace(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/g, (m, d, mth, y) => {
             const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
             return `${d} ${months[parseInt(mth)-1]} ${y}`;
        })
        
        // 🛡️ Swap 2: DD/MM goes SECOND
        .replace(/\b(\d{1,2})[\/-](\d{1,2})\b/g, (match, d, m) => {
            if (parseInt(m) > 12) return `${d} to ${m}`; 
            const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            return `${d} ${months[parseInt(m)-1]}`;
        })
        
        .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[ \t]*(\d{1,2})(?!\s*(?:room|bed|pax|guest|dbl|trp|quad|quint))\b/gi, '$2 $1');

      let lines = preProcessedText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      let pairedLines = [];
      let dateBuffer = null;

      for (let i = 0; i < lines.length; i++) {
          let line = lines[i];

          // 🛑 GUARD 1: If line ALREADY has "12 to 15", don't split it!
          // 🛡️ FIX: This now properly detects "19 jan to 02 feb" and keeps it whole
          if (/\d.*\s+(to|-)\s+\d/i.test(line)) {
              if (dateBuffer) { pairedLines.push(dateBuffer); dateBuffer = null; }
              pairedLines.push(line);
              continue;
          }


          // 🛡️ FIX 43: PRESERVE "NIGHTS" (The Duration Fix)
          // This prevents "19 feb for 3 nights" from becoming just "19 feb"
          if (/\b\d+\s*nights\b/i.test(line)) {
              if (dateBuffer) { pairedLines.push(dateBuffer); dateBuffer = null; }
              pairedLines.push(line);
              continue;
          }

          // 🛑 GUARD 2: Ignore "Room Count" lines
          if (/^\d+\s*(room|pax|guest|adult|child|quad|quint|trp|trip|dbl|doub|sgl|sing|bed)/i.test(line)) {
              if (dateBuffer) { pairedLines.push(dateBuffer); dateBuffer = null; }
              pairedLines.push(line);
              continue;
          }

          // Keyword Detection
          let isDateLine = /^(?:check\s*in|chk\s*in|arr|from|arriving|check\s*out|chk\s*out|dep|to|in|out|leaving)[:\s-]*(\d.*)/i.exec(line);
          
          if (!isDateLine) {
            const pureDate = /^(\d{1,2}(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec).*)/i.exec(line);
              if (pureDate) isDateLine = [line, pureDate[1]]; 
          }
          
          if (isDateLine) {
              let extractedDate = isDateLine[1] || isDateLine[2]; 
              extractedDate = extractedDate.trim();

              if (!dateBuffer) {
                  dateBuffer = extractedDate; 
              } else {
                  pairedLines.push(`${dateBuffer} to ${extractedDate}`);
                  dateBuffer = null; 
              }
          } else {
              if (dateBuffer) { pairedLines.push(dateBuffer); dateBuffer = null; }
              pairedLines.push(line);
          }
      }
      if (dateBuffer) pairedLines.push(dateBuffer);

      // Neighbor Date Fuser (Fallback)
      let stage3Lines = [];
      const strictMonthRegex = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

      for (let i = 0; i < pairedLines.length; i++) {
        let current = pairedLines[i];
        let next = (pairedLines[i+1] || "").trim();
        
        // 🛡️ Only merge if BOTH lines actually contain a month name
        if (strictMonthRegex.test(current) && strictMonthRegex.test(next) && !current.toLowerCase().includes('to')) {
          stage3Lines.push(`${current} to ${next}`);
          i++;
        } else {
          stage3Lines.push(current);
        }
      }

      // The "Hotel Slasher"
      let stage4Lines = [];
      stage3Lines.forEach(line => {
          if (line.includes('/') && !/\d/.test(line)) { 
              stage4Lines.push(...line.split('/').map(h => h.trim()));
          } else {
              stage4Lines.push(line);
          }
      });

// Final Noise Scrubber
      let effectiveText = stage4Lines
        // 🛡️ FIX 9: Don't delete the line! Just remove the noise words.
        .map(line => line.replace(/saudi arabia|street|road|district|jabal omar|ibrahim al khalil/gi, '')) 
        .filter(line => !/\b\d{5}\b/.test(line)) 
        .filter(line => {
             const isLong = line.split(' ').length > 15;
             const hasKey = /check|arr|dep|night|room|bed|guest|leaving|arriving/i.test(line);
             return !isLong || hasKey; 
        }) 
        .join('\n')
        .replace(/^(check\s*in|check\s*out|chk|arr|dep|from|to|in|out|arriving|leaving)[:\s-]*/gim, '');

      console.log("💎 Final Processed Text for AI:\n", effectiveText);

      // ============================================================
      // 🛡️ 2. SEGMENTATION & BLOCK FUSING
// ============================================================
      // 🛡️ 2. SEGMENTATION & FALLBACKS
      // ============================================================
      let segmentation;
      try {
        segmentation = await segmentClientQuery(effectiveText);
      } catch (err) {
        console.log("⚠️ AI Segmentation errored, using fallback block.");
      }

      let { blocks: rawBlocks } = segmentation || {};
      let blocks = [];
      if (Array.isArray(rawBlocks)) blocks = rawBlocks;

      // 🛡️ SAFETY NET: If AI returned NO blocks, create a default one from text
      // This fixes cases where AI segmentation fails completely on simple queries
      if (blocks.length === 0) {
          console.log("⚠️ No AI blocks. Creating default block from text.");
          blocks.push({
              hotels: [],
              dates: effectiveText // Pass text as dates context for now
          });
      }

      // Filter invalid hotels from AI blocks
      for (const block of blocks) {
        if (Array.isArray(block.hotels)) {
            block.hotels = block.hotels.filter(h => !isRoomOnlyLine(h));
        }
      }

// 🛡️ INTELLIGENT SCANNER & RESCUER
      // 1. Fix Empty Blocks
      for (const block of blocks) {
        if (!Array.isArray(block.hotels) || block.hotels.length === 0) {
          console.log("🔍 Scanning text for hotels (Empty Block Fallback)...");
          const candidates = effectiveText.split('\n').map(l => l.trim()).filter(Boolean);
          block.hotels = candidates.filter(line => !isRoomOnlyLine(line));
        }
      }

// 🛡️ 2. RESCUE ORPHAN HOTELS
      const allDetectedHotels = new Set();
      blocks.forEach(b => (b.hotels || []).forEach(h => allDetectedHotels.add(h)));

      const textLines = effectiveText.split('\n').map(l => l.trim()).filter(Boolean);
      const orphanHotels = [];
      
      textLines.forEach(line => {
          if (!isRoomOnlyLine(line) && normalizeHotelForAI(line)) {
              const alreadyFound = Array.from(allDetectedHotels).some(h => h.includes(line) || line.includes(h));
              if (!alreadyFound) orphanHotels.push(line);
          }
      });

      if (orphanHotels.length > 0) {
          console.log("⛑️ Rescued Orphan Hotels:", orphanHotels);
          if (blocks.length > 0) {
              if (!blocks[0].hotels) blocks[0].hotels = [];
              blocks[0].hotels.unshift(...orphanHotels); 
          } else {
              // 🛡️ FIX 9: Create new block if none exist
              blocks.push({
                 hotels: orphanHotels,
                 dates: effectiveText
              });
          }
      }
      
      const HUMAN_AGENT_ID = '243159590269138@lid'; 

// 🚨 FAILURE 1: NO VALID BLOCKS (Orphan rescue failed)
      if (blocks.length === 0) {
        // 🧠 Check if they are just chatting (No months, no rooms, no hotel words)
        const isJustChatting = !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|room|dbl|double|trp|triple|quad|quint|suite|bed|pax|hotel|night)\b/i.test(effectiveText);
        
        if (isJustChatting) {
            console.log("🤫 Silently ignoring normal chat (No blocks).");
            return;
        }

        console.log("⚠️ ");
        await sock.sendMessage(groupId, { 
            text: `@${HUMAN_AGENT_ID.split('@')[0]} `,
            mentions: [HUMAN_AGENT_ID] 
        }, { quoted: msg });
        
        return;
      }

      // ============================================================
      // 💾 DATABASE: SAVE PARENT QUERY
      // ============================================================
      const parentId = createParentQuery({
          message_id: msg.key.id,
          remote_jid: groupId,
          participant: senderId,  // Ensure 'userId' is defined in your scope
          original_text: effectiveText,
      });

      console.log(`📝 DB: Saved Parent Query ID: ${parentId}`);

      // 🚀 PHASE 2.5: START THE AUTO-QUOTER TIMER!
      autoQuoter.startTimer(parentId);
      // ... (Code continues to globalHotels extraction)
      const allQueries = [];
      
      const globalDateRanges = [];
      const sameMonthRegex = /(\d{1,2})[\s-]*(?:to|[-/]|and)[\s-]*(\d{1,2})[\s-]*([a-z]{3,9})/gi;
      let m;
      while ((m = sameMonthRegex.exec(effectiveText)) !== null) globalDateRanges.push(`${m[1]} ${m[3]} to ${m[2]} ${m[3]}`);
      
      const crossMonthRegex = /(\d{1,2})\s*([a-z]{3,9})[\s-]*(?:to|[-/]|and)[\s-]*(\d{1,2})\s*([a-z]{3,9})/gi;
      while ((m = crossMonthRegex.exec(effectiveText)) !== null) globalDateRanges.push(`${m[1]} ${m[2]} to ${m[3]} ${m[4]}`);

      // 🛑 SMART LIMIT: Trim Global Dates
      if (globalDateRanges.length > clientLimits.max_date_ranges) {
          globalDateRanges.length = clientLimits.max_date_ranges; 
      }

      let globalHotels = [];

      blocks.forEach(b => globalHotels.push(...(b.hotels || [])));
      globalHotels = [...new Set(globalHotels)]; 

      // ============================================================
      // 🛡️ HARD FILTER: "ANY" REMOVAL
      // ============================================================
      // Logic: 
      // 1. Remove ALL hotels starting with "Any" (e.g. "Any 5 star", "Any good hotel")
      // 2. If NO hotels remain, DROP THE PARENT QUERY COMPLETELY.

      const specificHotels = globalHotels.filter(h => !/^any\b/i.test(h));

      if (specificHotels.length < globalHotels.length) {
          console.log("🧹 Dropped generic 'Any...' hotels.");
          
          // 1. Update the Global List to only specific ones
          globalHotels = specificHotels;

          // 2. Clean up the blocks so we don't process "Any" later
          blocks.forEach(b => {
              if (b.hotels) {
                  b.hotels = b.hotels.filter(h => !/^any\b/i.test(h));
              }
          });
      }

      // 🚨 FAILURE 2: ONLY "ANY" HOTELS FOUND
      if (globalHotels.length === 0) {
          console.log("⚠️ ");
          
          await sock.sendMessage(groupId, { 
            text: `@${HUMAN_AGENT_ID.split('@')[0]} .`,
            mentions: [HUMAN_AGENT_ID] 
        }, { quoted: msg });
          
          return;
      }

      // 🚨 KILL SWITCH: If no specific hotels remain, STOP.
      if (globalHotels.length === 0) {
          console.log("⚠️.");
          return;
      }


      let sanitizedMap = {};
      if (globalHotels.length > 0) {
          console.log("🧹 Sanitizing hotels:", globalHotels);
          const cleaned = await sanitizeHotelNames(globalHotels);
          console.log("✅ Result:", cleaned);

          // ============================================================
          // 🛡️ FIX: "MAKKAH HOTEL" LABEL BUG (Post-Sanitization)
          // ============================================================
          // Logic: Now that names are clean ("Makah hotel:" -> "Makkah Hotel"), 
          // we check if "Makkah Hotel" exists alongside other hotels.
          
          const makkahIndex = cleaned.findIndex(h => h && h.toUpperCase() === 'MAKKAH HOTEL');
          const hasOthers = cleaned.some((h, i) => h && i !== makkahIndex);

          if (makkahIndex !== -1 && hasOthers) {
               console.log(`🧹 Dropping 'Makkah Hotel' (Label) post-sanitization.`);
               cleaned[makkahIndex] = "DROP_ME"; // Mark for deletion
          }

          // ============================================================
          // 🗺️ MAP RAW -> CLEAN
          // ============================================================
          globalHotels.forEach((raw, i) => { 
              if (cleaned[i] === "DROP_ME") {
                  return; // 🚫 Skip adding this to the map (effectively deletes it)
              }
              
              if (cleaned[i]) {
                  sanitizedMap[raw] = cleaned[i];
              } else {
                  console.log(`⚠️ Sanitizer missed "${raw}", using raw value.`);
                  sanitizedMap[raw] = raw; 
              }
          });
      }      
      let lastKnownHotels = []; 

      // 🕵️ CONVERSATIONAL REPAIR
      // 🛡️ FIX: Added "last ashra" and "ramadan" to the date check
// 🕵️ CONVERSATIONAL REPAIR
// 🕵️ CONVERSATIONAL REPAIR
      // 🛡️ FIX: Added support for 'st', 'nd', 'rd', 'th' and spaces inside dates!
      const hasDate = /(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:to|-)?\s*(\d{1,2})?\s*(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(effectiveText) || 
                      /last\s*ashra|ramadan/i.test(effectiveText);

      // 🛡️ FIX: Added 'tripl' to the list of acceptable room words
      const hasRoom = /\b(sgl|single|dbl|double|tw|twin|trp|tripl|triple|tripple|quad|quard|qad|qued|quint|pax|bed|room|guest|person|prsn|ppl|suite|studio|family)s?\b/i.test(effectiveText);      
      // 🛡️ SILENT FAIL: Just clear memory and ignore if missing data. No spamming!
      if (!hasRoom && hasDate) {
          setPendingQuestion(groupId, { originalText: effectiveText, missing: 'ROOM' });
          console.log("⚠️ Ignored: Missing Room. Waiting silently for user to provide it.");
          return;
      }
      if (!hasDate && hasRoom) {
          setPendingQuestion(groupId, { originalText: effectiveText, missing: 'DATE' });
          console.log("⚠️ Ignored: Missing Date. Waiting silently for user to provide it.");
          return;
      }
      clearPendingQuestion(groupId);
// ============================================================
      // 🛡️ 3. MAIN PROCESSING LOOP
      // ============================================================
      // 🛑 SMART LIMIT: Initialize Child Query Counters
      let requestCount = 0;
      let limitReached = false;

     blockLoop: for (const block of blocks) {


        let blockDateList = [];
        if (block.dates) {
          const rawLines = block.dates.split('\n').map(l => l.trim()).filter(Boolean);
          const cleanLines = rawLines.map(l => l.replace(/^(check\s*[-]?\s*(in|out|inn|date)|arr|dep|arrival|departure|from|to)[:\s-]*/i, '').trim());
          
          const mergedDates = [];
          for (let i = 0; i < rawLines.length; i++) {
            const currentClean = cleanLines[i];
            const nextClean = cleanLines[i+1];
            
            if (isPureDateLine(currentClean) && isPureDateLine(nextClean) && !currentClean.includes('to')) {
              mergedDates.push(`${currentClean} to ${nextClean}`);
              i++; 
            } else {
              mergedDates.push(currentClean);
            }
          }
          blockDateList = mergedDates;
        }

        // 🛑 SMART LIMIT: Trim Block Dates
        if (blockDateList.length > clientLimits.max_date_ranges) {
             blockDateList = blockDateList.slice(0, clientLimits.max_date_ranges);
        }

        if (blockDateList.length === 0 && globalDateRanges.length > 0) blockDateList = globalDateRanges;


        let splitHotels = [];
        (block.hotels || []).forEach(h => {
             splitHotels.push(...h.split(/\s*\/\s*|\s+or\s+|\s*&\s*|,\s*|\n/i).map(s => s.trim()).filter(Boolean));
        });
        
    

        // 1. Split BOTH the cleaned text and the original text into lines
        const cleanedLines = preProcessedText.split('\n').map(l => l.trim());
        const originalLines = rawText.split('\n').map(l => l.trim());

        const potentialHotels = [];
        
        // 🛡️ BRAND GLUE: List of brands that should "grab" the next line if they are alone
        const splitBrands = /emaar|pullman|swiss|voco|fairmont|hilton|movenpick|meridien|clock|royal|zamzam/i;

        for (let i = 0; i < cleanedLines.length; i++) {
            let line = cleanedLines[i];
            if (!line || line.length < 3) continue;

            const originalLine = originalLines[i] || line;
            
            // 🔗 THE GLUE LOGIC: If 'Emaar' is on one line and 'Royal' on next, combine them
            const isSingleWord = line.split(/\s+/).length === 1;
            if (isSingleWord && splitBrands.test(line) && i + 1 < cleanedLines.length) {
                const nextLine = cleanedLines[i + 1];
                // Only glue if next line isn't a date, room, or meal
                const isDataLine = isRoomOnlyLine(nextLine) || 
                                   nextLine.match(/\d{1,2}\s*(?:jan|feb|mar)/i) ||
                                   /view|suhoor|iftar/i.test(nextLine);
                                   
                if (!isDataLine) {
                    line = `${line} ${nextLine}`;
                    i++; // Skip the next line in the next iteration
                }
            }

            const isJunk = isJunkLine(line);
            const isRoom = isRoomOnlyLine(line);
            const isDate = line.match(/\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i);
            
// 🛡️ THE ATTRIBUTE SHIELD: Made stricter so it doesn't accidentally block "Sky View"
            const isAttribute = /^(view|meal|board|sharing)$/i.test(line.trim().toLowerCase()) || 
                                /\b(city view|haram view|kaaba view|partial view|suhoor|iftar|breakfast|half board|full board)\b/i.test(line);


                                // 🛡️ RESCUE RULES: Match against our massive list of known hotel brands
            const hotelBrandKeywords = /\b(hotel|inn|suites|lamar|emaar|jabal|tower|towers|palace|movenpick|hilton|rotana|front|manakha|nebras|view|residence|grand|plaza|voco|sheraton|accor|pullman|anwar|dar|taiba|saja|emmar|andalusia|royal|shaza|millennium|ihg|marriott|fairmont|clock|al|bakka|retaj|rawda|golden|tulip|kiswa|kiswah|khalil|safwat|madinah|convention|tree|doubletree|tripleone|fundaq|bilal|elaf|kindi|bosphorus|zalal|nuzla|matheer|artal|odst|zowar|miramar|ruve|nozol|diafa|shourfah|manar|iman|harmony|leader|mubarak|wissam|concord|vision|hidayah|hidaya|hedaya)\b/i;
            
            const hasHotelKeyword = hotelBrandKeywords.test(originalLine) || splitBrands.test(line);
            const isValidPhrase = line.split(/\s+/).filter(w => w.length > 2).length >= 2;
            
            // 🛡️ THE ULTIMATE BYPASS: If the global scanner already verified it, keep it!
            const isAlreadyGlobal = globalHotels.some(gh => gh.toLowerCase() === line.toLowerCase());

            if (!isJunk && !isRoom && !isDate && !isAttribute) {
                if (hasHotelKeyword || isValidPhrase || isAlreadyGlobal) {
                    potentialHotels.push(line);
                }
            }
        }

// --- SANITIZATION & LOOP ---

        let rawSanitizedResults = await sanitizeHotelNames(potentialHotels);
        
        // 🛡️ THE CRASH FIX: Initialize these BEFORE the loop starts!
        let sanitizedHotels = [];
        const finalSanitizedMap = {}; 

        potentialHotels.forEach((raw, index) => {
            // Safely grab the matched name, avoiding undefined errors if the array acts weird
            const matchedName = (Array.isArray(rawSanitizedResults) && rawSanitizedResults[index]) ? rawSanitizedResults[index] : null;
            
            // Search the ORIGINAL text lines to find stripped keywords
            const originalLine = originalLines.find(ol => ol.toLowerCase().includes(raw.toLowerCase())) || raw;
            
            // 🛡️ FIX 1: MASSIVELY EXPANDED STRONG KEYWORDS
            // Added: arkan, manar, plaza, palace, qasr, maqam, resort, boutique
            const hasStrongKeyword = /hotel|fundaq|fandaq|saif|majd|dar|tower|inn|suites|stay|voco|pullman|swiss|hilton|meridien|emaar|royal|fairmont|zamzam|makkah|nabras|nebras|taiba|sky\s*view|arkan|manar|plaza|palace|qasr|maqam|resort|boutique/i.test(originalLine);
            
            // 🛡️ FIX 2: THE BULLETPROOF FALLBACK (The "Perfect Name" Detector)
            // If the sanitizer fails, but the text is 2-5 words, has NO numbers, and NO room/meal keywords, it IS a hotel!
            const isJunkHotel = /room|bed|pax|guest|dbl|double|trp|triple|quad|quint|suite|breakfast|bb|ro|hb|fb|meal|view|haram|city|kaaba|night|days/i.test(raw);
            const hasNumbers = /\d/.test(raw);
            const wordCount = raw.trim().split(/\s+/).length;
            const looksLikePerfectHotelName = !hasNumbers && !isJunkHotel && wordCount >= 2 && wordCount <= 5;

            // Validation Gate Logic: Keep if DB match OR strong keyword OR looks perfectly like a hotel
            if ((matchedName && matchedName !== 'DROP_ME') || (hasStrongKeyword && raw.length > 3) || looksLikePerfectHotelName) {
                // If matchedName is valid, use it. Otherwise safely fall back to the raw name.
                const finalName = (matchedName && matchedName !== 'DROP_ME') ? matchedName : raw; 
                sanitizedHotels.push(finalName);
                finalSanitizedMap[raw] = finalName;
            } else {
                console.log(`🗑️ Dropping non-hotel junk: "${raw}"`);
            }
        });
        // 2. Remove Duplicates & Maintain "Again/Same" logic
        sanitizedHotels = [...new Set(sanitizedHotels)];

        // 🛑 SMART LIMIT: Trim Max Hotels Per Message
        if (sanitizedHotels.length > clientLimits.max_hotels_per_date) {
             sanitizedHotels = sanitizedHotels.slice(0, clientLimits.max_hotels_per_date);
        }

        const isAgain = rawText.toUpperCase().includes('AGAIN') || rawText.toUpperCase().includes('SAME');
        if ((sanitizedHotels.length === 0 || (sanitizedHotels.length === 1 && /AGAIN|SAME/i.test(sanitizedHotels[0]))) && isAgain) {
           if (lastKnownHotels.length > 0) sanitizedHotels = lastKnownHotels;
        } else {
           const validNow = sanitizedHotels.map(h => normalizeHotelForAI(h)).filter(Boolean);
           if (validNow.length > 0) lastKnownHotels = validNow;
        }

        // 3. Process the Loop
        for (const hotelName of sanitizedHotels) {
 

          const hotel = normalizeHotelForAI(hotelName);
          if (!hotel) continue;

          // 🛡️ Use our cleaned finalSanitizedMap to find what the user actually typed
          const rawNameInText = Object.keys(finalSanitizedMap).find(key => finalSanitizedMap[key] === hotelName) || hotelName;

          // Now we search the text using the raw name, not the clean one!
          const fullLine = effectiveText.split('\n').find(l => l.toLowerCase().includes(rawNameInText.toLowerCase())) || rawNameInText;
          
         let activeTypes = extractRoomTypesFromText(fullLine);
          if (activeTypes.length === 0) activeTypes = universalTypes;
          
          // 🛑 SMART LIMIT: Trim Room Types
          if (activeTypes.length > clientLimits.max_room_types) {
              activeTypes = activeTypes.slice(0, clientLimits.max_room_types);
          }

          const mealHint = extractMeal(effectiveText);
          const viewHint = extractView(effectiveText);

          const allContextDates = [...new Set([...blockDateList, ...globalDateRanges])];          
          // ... rest of your AI call logic ...// 🛡️ SMART CONTEXT PROMPT
            // 🛡️ SMART CONTEXT PROMPT
// 🛡️ SMART CONTEXT PROMPT (RESTORED TO 9 RULES)
         // 🛡️ THE CONTEXT WINDOW: Physically isolate the lines near the hotel
          const linesForWindow = effectiveText.split('\n');
          const hotelLineIndex = linesForWindow.findIndex(l => l.toLowerCase().includes(rawNameInText.toLowerCase()));
          
          // Grab 3 lines above and 3 lines below to prevent "Stealing" from far-away sections
          const startWindow = Math.max(0, hotelLineIndex - 3);
          const endWindow = Math.min(linesForWindow.length, hotelLineIndex + 4);
          const localContext = linesForWindow.slice(startWindow, endWindow).join('\n');

          const aiInput = protectDoubleTreeHotel([
              `### TARGET HOTEL: ${hotel}`,
              `### LOCAL CONTEXT (Restricted View): \n${localContext}`, 
              `### DEFAULTS: Meal=${mealHint}, View=${viewHint}, Rooms=1`,
              
              `--- EXTRACTION PROTOCOL (STRICT 9 RULES) ---`,
              `1. THE ADJACENCY RULE: ONLY extract the date range found within the LOCAL CONTEXT provided. Priority is the date immediately above or below the hotel name.`,
              `2. THE BARRIER RULE: "Makkah" and "Madina" are impenetrable walls. Do not cross them to find a date.`,
              `3. THE STEALING TRAP: Never give Date A to Hotel B if they belong to different sections.`,
              `4. ANTI-GREED RULE: Do not extract every date in the text. Only return the specific date for ${hotel}.`,
              `5. LIST / HEADER EXCEPTION: If the context shows a date at the top and this hotel is part of a numbered list below it, apply that top date.`,
              `6. DATE MATH: "15 20 mar" = Check-in 15 Mar, Check-out 20 Mar.`,
              `7. PAX & ROOM LOGIC: Triple=3, Quad=4, Double/Twin=2. Use explicit counts (e.g., "6 persons") if mentioned.`,
              `8. MEALS & VIEWS: Use the hints (${mealHint}/${viewHint}) as defaults. Only change them if the local context explicitly says otherwise.`,
              `9. ISOLATION: Return data for "${hotel}" ONLY.`,
              
              `STRICT OUTPUT: Return ONLY a JSON object with the 'queries' array.`
          ].join('\n'));
          let ai;
          try { 
              ai = await parseClientMessageWithAI(aiInput); 
          } catch (err) { continue; }
            if (!ai?.queries) continue;

            for (const qRaw of ai.queries) {
              // 🛑 SMART LIMIT: Max Child Queries Enforcer
              if (requestCount >= clientLimits.max_child_queries) {
                  limitReached = true;
                  break blockLoop;
              }

              const q = { ...qRaw };
              
              // Only use the fallback if the fallback is ACTUALLY a valid hotel name
              if (!normalizeHotelForAI(q.hotel)) {
                  q.hotel = hotel;
              }

              // 🛡️ THE ULTIMATE BOUNCER: Absolute ban on these phrases reaching the database
              const finalClean = q.hotel.toUpperCase().trim();
              if (
                  finalClean === 'IN' || 
                  finalClean === 'OUT' || 
                  finalClean.includes('CHK') || 
                  finalClean.includes('METER') || 
                  finalClean.includes('DISTANCE') ||
                  finalClean === 'ANY' ||
                  finalClean.length <= 2 // Real hotels are never 1 or 2 letters long
              ) {
                  q.hotel = ''; // Nuke it to an empty string so it hits Catch-All vendors
              }

              if (q.check_out && q.check_out.includes('NaN')) {
                 const low = effectiveText.toLowerCase();
                 if (low.includes('apri')) q.check_out = q.check_out.replace(/-NaN-/, '-04-');
                 if (low.includes('marc')) q.check_out = q.check_out.replace(/-NaN-/, '-03-');
                 if (low.includes('feb')) q.check_out = q.check_out.replace(/-NaN-/, '-02-');
              }

            // 🛡️ FIX: Remove Ordinals (st, nd, rd, th) before parsing date
              if (q.check_in) q.check_in = q.check_in.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
              if (q.check_out) q.check_out = q.check_out.replace(/(\d+)(st|nd|rd|th)/gi, '$1');

              // 🛡️ SPECIAL DATE MAPPING: LAST ASHRA
              // Ramadan 2026 is approx Feb 17 - Mar 18.
              // Last Ashra is approx Mar 09 - Mar 19.
              
// 🛡️ SPECIAL DATE MAPPING: LAST ASHRA
              // Ramadan 2026 is approx Feb 17 - Mar 18.
              // Last Ashra is approx Mar 09 - Mar 19.
              
// 🛡️ SPECIAL DATE MAPPING: LAST ASHRA
              const isLastAshraRequest = /LAST\s*ASHRA/i.test(q.check_in) || /LAST\s*ASHRA/i.test(effectiveText);

              if (isLastAshraRequest) {
                   const userTypedSpecificDate = /(\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))|(\d{1,2}[\/-]\d{1,2})/i.test(effectiveText);
                   if (!userTypedSpecificDate || /LAST/i.test(q.check_in)) {
                       q.check_in = "2026-03-09"; 
                       q.check_out = "2026-03-19";
                       q.dateLabel = "LAST ASHRA"; 
                   }
              }

              // 🛡️ FIX: STRICT DATE VALIDATION (Anti-Hallucination)
              // If the AI gives us a date, BUT the user's text contains NO digits and NO date keywords...
              // Then the AI is hallucinating. KILL THE DATE.
              const hasRealDateInText = 
                  /\d/.test(effectiveText) || // Has numbers
                  /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(effectiveText) || // Has months
                  /last\s*ashra|ramadan|today|tomorrow|tonight/i.test(effectiveText); // Has keywords

              if (q.check_in && !hasRealDateInText) {
                  console.log(`⛔ Hallucination Detected: AI invented date ${q.check_in} but text has no dates. Dropping.`);
                  q.check_in = null;
                  q.check_out = null;
              }

              const cIn = new Date(q.check_in);
              const cOut = new Date(q.check_out);
              
              if (isNaN(cIn.getTime()) || isNaN(cOut.getTime())) {
                  console.log("⚠️ Invalid Date from AI:", q.check_in, q.check_out);
                  continue;
              }

              // 🛡️ FIX: Ambiguous 1-Night Guard (RELAXED)
              // We ALLOW single dates if the user specified a Room Type (e.g. "2 quad")
              const duration = (cOut - cIn) / (1000 * 60 * 60 * 24);
              const hasExplicitRooms = /\b(dbl|double|trp|triple|quad|quint|suite|bed|room|pax)\b/i.test(effectiveText);
              
              if (duration <= 1 && !rawText.toLowerCase().includes('night') && !hasExplicitRooms) {
                  console.log("⚠️ Ambiguous 1-night stay (No room info). Skipping.");
                  continue;
              }

            if (q.check_in === q.check_out) continue; // Basic sanity check
              
              if (q.confidence === 0) continue;
              
              // Apply Global Hints if missing
              if (!q.meal && mealHint) q.meal = mealHint;
              if (viewHint) {
                  q.view = viewHint; 
              } else if (!q.view) {
                  q.view = "CITY VIEW"; 
              }
              
              // 🛡️ FIX 26-B: Room Count Sanity Cap
              // Ignore numbers > 50 (Prevents years like "2026" being treated as room count)
              const rawCountMatch = effectiveText.match(/(\d+)\s*(?:room|dbl|double|quad|trip|trp|quint)/i);
              if (rawCountMatch) {
                  const val = parseInt(rawCountMatch[1], 10);
                  // Only update if room count is realistic (e.g. less than 50) AND current count is 1
                  if (!isNaN(val) && val < 50 && q.rooms === 1) {
                      q.rooms = val;
                  }
              }

              if (activeTypes.length > 0) {
                  let match = activeTypes.find(t => q.room_type.toUpperCase().includes(t) || t.includes(q.room_type.toUpperCase()));
                  if (!match) match = activeTypes[0];
                  
                  const aiAddedExtra = q.room_type.toUpperCase().includes('EXTRA');
                  const userSaidExtra = effectiveText.toUpperCase().includes('EXTRA') || effectiveText.toUpperCase().includes('SHARING');
                  if (aiAddedExtra && !userSaidExtra) q.room_type = match; 
                  else q.room_type = match;
              }

              if (typeof q.persons === 'number' && q.persons >= 1) {
                  const isVariableCapacity = /SUITE|STUDIO|APARTMENT|VILLA|CHALET|FAMILY/i.test(q.room_type);
                  if (isVariableCapacity) {
                      const paxLabel = `(${q.persons} Pax)`;
                      if (!q.room_type.toUpperCase().includes('PAX')) {
                          q.room_type = `${q.room_type} ${paxLabel}`;
                      }
                  }
              }

              if (!q.rooms || q.rooms < 1) q.rooms = 1;

              // 🛡️ FIX: Expand AI Abbreviations
              if (q.meal === 'IF') q.meal = 'IFTAR';
              if (q.meal === 'SU') q.meal = 'SUHOOR';

               // ============================================================
               // 💾 DATABASE: SAVE CHILD QUERY
               // ============================================================
               const childId = createChildQuery({
                   parent_id: parentId,
                   hotel_name: q.hotel,
                   check_in: q.check_in,
                   check_out: q.check_out,
                   room_type: q.room_type,
                   rooms: q.rooms,
                   persons: q.persons,
                   meal: q.meal || '',
                   view: q.view || ''
               });
               
               // Attach ID to the object so we can use it later when sending to vendors
               q.db_child_id = childId; 
               
               console.log(`   ↳ 📝 DB: Saved Child Query ID: ${childId} (${q.hotel})`);

               autoQuoter.linkChildToParent(childId, parentId);

              if (q.check_in && q.check_out) {
                  allQueries.push(q);
                  requestCount++;
              }

          }
       } 
      }
      
      
      // 🚨 FAILURE 3: NO VALID QUERIES GENERATED (After parsing)
      if (!allQueries.length) {
        // 🧠 Check if they are just chatting
        const isJustChatting = !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|room|dbl|double|trp|triple|quad|quint|suite|bed|pax|hotel|night)\b/i.test(effectiveText);
        
        if (isJustChatting) {
            console.log("🤫 Silently ignoring normal chat (AI returned empty).");
            return;
        }

        console.log("⚠️ Booking rejected (no valid queries). Summoning human.");
        await sock.sendMessage(groupId, { 
            text: `@${HUMAN_AGENT_ID.split('@')[0]} ⚠️`,
            mentions: [HUMAN_AGENT_ID] 
        }, { quoted: msg });
        
        return;
      }

      // ============================================================
      // 🛡️ 4. FINAL DEDUPLICATION (The "Simple Rule")
      // ============================================================
      // Rule: SAME HOTEL & SAME DATES & SAME ROOM TYPE -> NEVER REPEAT
      
      const uniqueQueries = [];
      const seenSignatures = new Set();

      for (const q of allQueries) {
          // 1. Normalize Hotel Name for Comparison ONLY
          const cleanName = (sanitizedMap[q.hotel] || q.hotel).toLowerCase()
              .replace(/\b(makkah|madinah|hotel|hotels|convention|towers|tower|jabal|omar|al|residence|suites|inn|view|guest|house)\b/gi, '')
              .replace(/[^a-z0-9]/g, '') // Remove symbols
              .trim();

          // 2. Create the Signature
          const signature = `${cleanName}|${q.check_in}|${q.check_out}|${q.room_type}`;

          // 3. Check & Push (FIXED LOGIC)
          if (!seenSignatures.has(signature)) {
              seenSignatures.add(signature);
              uniqueQueries.push(q);
          } else {
              console.log(`🗑️ Duplicate Skipped: ${q.hotel} (${q.check_in})`);
          }
      }
      
      // Update the main list to use the unique ones
      const finalQueries = uniqueQueries;

      const queriesWithRates = [];
      const queriesForVendors = [];

      // Check V1 Static Rates First
      for (const q of finalQueries) {
        const myRate = checkSavedRate(
            q.hotel, q.check_in, q.check_out, q.persons || 2, 
            q.room_type, q.view, q.meal
        );
        if (myRate) queriesWithRates.push({ query: q, rate: myRate });
        else queriesForVendors.push(q);
      }

      // Send V1 Static Rates
      for (const item of queriesWithRates) {
          const { query, rate } = item;
          const fullType = rate.room_descriptor || 'Room';
          const modifiers = ["DIPLOMATIC", "EXECUTIVE", "ROYAL", "PRESIDENTIAL", "DELUXE", "CLUB", "GRAND", "PREMIER"];
          let descriptor = '';
          let typeClean = fullType;
          for (const mod of modifiers) {
              if (fullType.toUpperCase().includes(mod)) {
                  descriptor = mod;
                  typeClean = fullType.replace(new RegExp(mod, 'gi'), '').trim();
                  break;
              }
          }
          const totalAmount = rate.breakdown.reduce((sum, b) => sum + b.price, 0);
          const averageRate = Math.round(totalAmount / rate.breakdown.length);
          const mealViewLine = `${rate.applied_meal}${rate.applied_view ? ` / ${rate.applied_view}` : ''}`;
          
          const dateDisplay = formatDateRange(query.check_in, query.check_out, query.dateLabel);

          const replyText = 
`*${rate.hotel}* ${dateDisplay}
${descriptor ? `*${descriptor}* ` : ''}${typeClean}
${mealViewLine}

*${averageRate} ${rate.currency}*

*Subject to Availability*`;
          await sock.sendMessage(groupId, { text: replyText }, { quoted: msg });
      }

      // Process Vendor Group Queries
      if (queriesForVendors.length > 0) {
          await sock.sendMessage(groupId, { text: 'checking' }, { quoted: msg });

          // 🧠 INTELLIGENT DISTRIBUTION LOGIC
          const queriesByDate = {};
          for (const q of queriesForVendors) {
              const key = `${q.check_in}|${q.check_out}`;
              if (!queriesByDate[key]) queriesByDate[key] = [];
              queriesByDate[key].push(q);
          }

          // Process each Date Range independently
          for (const [dateKey, queries] of Object.entries(queriesByDate)) {
              
              const usedVendorsForThisDate = new Set();
              const uniqueHotels = [...new Set(queries.map(q => q.hotel))];
              
              // Sort hotels by number of available vendors (Least options get priority)
              const hotelOps = uniqueHotels.map(hotel => {
                  return { 
                      hotel, 
                      vendors: getVendorsForHotelDB(hotel) 
                  };
              }).sort((a, b) => a.vendors.length - b.vendors.length);

              // Assign Vendors
              for (const op of hotelOps) {
                  const { hotel, vendors } = op;
                  
                  const hotelQueries = queries.filter(q => q.hotel === hotel);
                  if (hotelQueries.length === 0) continue;

                  const availableVendors = vendors.filter(v => !usedVendorsForThisDate.has(v));
                  const selectedVendors = availableVendors; // Send to ALL available vendors

                  if (selectedVendors.length > 0) {
                      // Loop through EVERY query for this hotel
                      for (const relevantQuery of hotelQueries) {
                          
                          // ============================================================
                          // 🛡️ V2.5 LOCAL RATE ENGINE CHECK (RIGHT BEFORE SENDING)
                          // ============================================================
                          console.log(`🔍 Checking local database for recent rates for ${hotel}...`);
                          
                          // Construct quoteData so the formatter knows where to send the instant reply
                          const localQuoteData = {
                              client_group_id: groupId,
                              client_msg_id: msg.key.id,
                              client_participant: msg.key.participant || msg.key.remoteJid,
                              original_text: effectiveText,
                              parent_id: parentId
                          };

                          const foundLocalRate = await processLocalRates(relevantQuery, sock, localQuoteData);

                          if (foundLocalRate) {
                              console.log(`✅ Skipped sending ${hotel} to vendors (Handled instantly from Local DB)`);
                              continue; // 🛑 Skips the vendor messaging entirely and moves to the next query!
                          }
                          // ============================================================

                          console.log(`📤 Sending ${hotel} (${relevantQuery.check_in} - ${relevantQuery.room_type}) to:`, selectedVendors);
                          
                          const dbChildId = relevantQuery.db_child_id;

                          if (!dbChildId) {
                              console.error("❌ Error: Missing DB Child ID for", hotel);
                              continue;
                          }
                          
                          const clientCode = getClientCodeDB(groupId) || 'REQ';

                          console.log(`🔍 [DEBUG] Pre-Format: ID=${dbChildId}, Code=${clientCode}`);

                          const vendorMessageText = formatQueryForVendor({ 
                              id: dbChildId,         
                              clientCode: clientCode, 
                              parsed: relevantQuery 
                          });

                          console.log(`🔍 [DEBUG] Final Text Preview: ${vendorMessageText.split('\n')[0]}`);

                          for (const vg of selectedVendors) {
                              // 1. Send Message
                              const sent = await sock.sendMessage(vg, { text: vendorMessageText });
                              
                              // 2. 💾 DATABASE: LOG REQUEST
                              if (sent?.key?.id) {
                                  logVendorRequest({
                                      child_id: dbChildId,
                                      vendor_group_id: vg,
                                      sent_message_id: sent.key.id
                                  });
                                  console.log(`      ↳ 🔗 DB: Linked Message ${sent.key.id} to Child ${dbChildId} [${clientCode}]`);
                              }
                              
                              await sleep(VENDOR_SEND_DELAY_MS);
                          }
                      } // <-- End of hotelQueries loop
                  } else {
                      console.log(`⚠️ Skipped ${hotel}: All vendors booked.`);
                  }
              }
          }
        }
      }
      // ======================================================
    // 🧪 V2 SHADOW MODE (Vendor Reply Handler)
    // ======================================================
    if (role === 'VENDOR' && type === 'VENDOR_REPLY') {
      
      let context = null;
      const ctx = msg.message.extendedTextMessage?.contextInfo;

      if (ctx?.stanzaId) {
          // 🛡️ Fetches full context including the 'meal' column we added to the SELECT
          context = getContextBySentMsgId(ctx.stanzaId);
      }

      if (!context) {
          console.log("⚠️ VENDOR_REPLY: Database could not find original message ID:", ctx?.stanzaId);
          return;
      }

      console.log(`✅ DB MATCH: Vendor replied to Query ID ${context.child_id} (${context.requested_hotel})`);

try {
            // ============================================================
            // 🕵️ DETECT HOTEL CHANGE (The "Le Meridien" Fix)
            // ============================================================
            let actualHotel = context.requested_hotel; 
            
            // 1. Clean the reply lines to find potential names
            const potentialLines = rawText.split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 3 && !isRoomOnlyLine(l) && !/^\d+/.test(l));

            if (potentialLines.length > 0) {
                console.log("🔍 Scanning reply for Hotel Name Override...", potentialLines);
                
                // 2. Run Sanitizer
                const sanitizedCandidates = await sanitizeHotelNames(potentialLines);
                let newHotel = sanitizedCandidates.find(h => h && h !== 'DROP_ME');
                
// 🛡️ THE RAW RESCUE: Improved with Price & Room Filter
                if (!newHotel) {
                    // 🛡️ THE FIX: Strip out conversational words FIRST!
                    let firstLine = potentialLines[0].replace(/can offer|we have|available|offering|how about|we can give|offer/ig, '').trim();
                    
                    const isPriceLine = /\d+\/\d+/.test(firstLine) || /@\s*\d+/.test(firstLine) || /^\d+$/.test(firstLine.replace(/[^\d]/g, ''));
                    const isRoomCode = /dbl|trp|quad|sgl|ro|bb|hb|fb/i.test(firstLine) && /\d+/.test(firstLine);
                    const isVendorJunk = /booked|sold|out|stop|sale|unavailable|w\.e|weekend|extra|ex\b|recheck|before|final|list|check|please|kindly|wait|let me|checking|dear|iftar|sahour|suhoor|sohour|breakfast|lunch|dinner|meal|inclusive|inc\b|with|without|only/i.test(firstLine);                    
                    
                    if (firstLine.length >= 3 && !isJunkLine(firstLine) && !isVendorJunk && !isPriceLine && !isRoomCode && firstLine.split(/\s+/).length <= 5) {
                        newHotel = firstLine; 
                        console.log(`⛑️ Vendor Hotel Rescued (Raw Text): "${newHotel}"`);
                    } else {
                        console.log(`🚫 Rescue Skipped: Line "${firstLine}" looks like a price or room code (or junk).`);
                        newHotel = context.requested_hotel;
                    }
                }
                  
                if (newHotel && newHotel.toLowerCase() !== actualHotel.toLowerCase()) {
                    console.log(`🔄 Hotel Override Detected: "${actualHotel}" -> "${newHotel}"`);
                    actualHotel = newHotel;

                    // 🛡️ NEW FIX: Permanently update the database for the Local Rate Engine
                    const { updateChildHotelName } = require('./database');
                    updateChildHotelName(context.child_id, actualHotel);
                    console.log(`💾 DB: Updated Child Query ${context.child_id} hotel name to ${actualHotel}`);
                }
            } // <-- THIS BRACKET CLOSES `if (potentialLines.length > 0)`

            // 🛡️ SMART VIEW DETECTION
            let detectedView = extractView(rawText); 
            if (!detectedView) {
                detectedView = context.view || "CITY VIEW";
            }
          // ============================================================
          // 🧮 PREPARE CALCULATOR (WITH MEAL FIX)
          // ============================================================
          const queryData = {
              hotel: actualHotel,
              check_in: context.check_in,
              check_out: context.check_out,
              room_type: context.room_type,
              rooms: context.rooms,
              persons: context.persons,
              db_child_id: context.child_id,
              view: detectedView,
              // 🛡️ THE CRITICAL FIX: Explicitly pass the meal from DB context to the calculator
              meal: context.meal || "" 
          };
          
          console.log(`🧪 V2: Calculation started for ${queryData.hotel}...`);
          
          const v2Quote = await calculateQuote(queryData, rawText);
          
          if (v2Quote) {
              // 1. SAVE QUOTE
              saveVendorQuote({
                  request_id: context.request_id,
                  raw_reply_text: rawText,
                  quoted_price: v2Quote.total_price || 0,
                  vendor_hotel_name: actualHotel,
                  is_match: 1, 
                  full_json: JSON.stringify(v2Quote)
              });
              
              // 2. UPDATE STATUS
              updateRequestStatus(context.request_id, 'REPLIED');
              console.log(`💾 DB: Saved Quote & Updated Status to REPLIED`);

              // 3. SEND TO OWNER
              const report = formatForOwner(v2Quote, context.request_id);
              const owners = getOwnerGroupsDB();
              for (const ownerGroupId of owners) {
                  await sock.sendMessage(ownerGroupId, { text: report });
              }

              const quoteData = getQuoteByReqId(context.request_id);
              if (quoteData) {
                  await autoQuoter.evaluateQuote(v2Quote, quoteData, context.child_id, sock);
              }

          } else {
              console.log("❌ V2: AI determined this is not a valid quote.");
          }
      } catch (err) {
          console.error("⚠️ V2 Critical Error:", err);
      }
      
      return; 
    }

  })
}

startBot()

// ... existing code (startBot, etc.) ...

// ======================================================
// 🌐 EXPRESS DASHBOARD (CONTROL PANEL)
// ======================================================
const express = require('express');
const session = require('express-session'); // 🛡️ NEW: Session manager
const app = express();
const { getGroupInfo, db, assignTierToGroup, upsertGroup } = require('./database'); 

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true })); 

// ==========================================
// 🔒 AUTHENTICATION SYSTEM
// ==========================================
app.use(session({
    secret: 'turalex-secure-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Login Page Route
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

// Login POST Handler (admin / admin)
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin') {
        req.session.loggedIn = true;
        res.redirect('/');
    } else {
        res.render('login', { error: 'Invalid username or password' });
    }
});

// Logout Handler
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// 🛡️ THE GATEKEEPER MIDDLEWARE
const requireAuth = (req, res, next) => {
    if (req.session.loggedIn) {
        next();
    } else {
        res.redirect('/login');
    }
};

// ❌ REMOVE the global app.use('/', requireAuth) line completely. 
// Instead, we inject it specifically into the routes below.

app.get('/', requireAuth, (req, res) => {
    try {
        // Safe check for Vendor Replies (in case the 'quotes' table isn't fully set up yet)
        let totalReplies = 0;
        try { totalReplies = db.prepare("SELECT COUNT(*) as count FROM quotes").get().count; } catch (e) {}

        const stats = {
            todayQueries: db.prepare("SELECT COUNT(*) as count FROM parent_queries WHERE date(created_at) = date('now')").get().count || 0,
            totalParentQueries: db.prepare("SELECT COUNT(*) as count FROM parent_queries").get().count || 0,
            totalChildQueries: db.prepare("SELECT COUNT(*) as count FROM child_queries").get().count || 0,
            totalReplies: totalReplies,
            activeClients: db.prepare("SELECT COUNT(*) as count FROM groups WHERE role = 'CLIENT'").get().count || 0,
            activeVendors: db.prepare("SELECT COUNT(*) as count FROM groups WHERE role = 'VENDOR'").get().count || 0,
        };

        const graphData = db.prepare(`
            SELECT date(created_at) as date, COUNT(*) as count 
            FROM parent_queries 
            WHERE created_at >= date('now', '-7 days')
            GROUP BY date(created_at)
            ORDER BY date ASC
        `).all();

        res.render('dashboard', { stats, graphData });
    } catch (err) {
        console.error("Dashboard Load Error:", err);
        res.status(500).send("Database Error");
    }
});


// 2. INLINE QUICK UPDATE
app.post('/group/:id/quick-update', express.urlencoded({ extended: true }), (req, res) => {
    try {
        const groupId = req.params.id;
        const { name, client_code, role, limit_tier, markup_tier } = req.body;

        db.prepare(`
            UPDATE groups 
            SET name = ?, client_code = ?, role = ?, limit_tier = ?, markup_tier = ?
            WHERE group_id = ?
        `).run(name, client_code, role, limit_tier || 'NONE', markup_tier || 'DEFAULT', groupId);

        res.redirect('/clients');
    } catch (err) {
        console.error("Update Error:", err);
        res.status(500).send("Failed to update group.");
    }
});

// Reuse your existing group detail route for the actual "Update Role" logic
app.get('/group/:id', requireAuth, (req, res) => {
    const info = db.prepare("SELECT * FROM groups WHERE group_id = ?").get(req.params.id);
    const tiers = db.prepare("SELECT tier_name FROM limit_tiers").all();
    res.render('group_edit', { info, tiers });
});
// 3. SAVE CHANGES: Handle Form Submission
app.post('/group/update', (req, res) => {
    const { group_id, name, limit_tier, client_code } = req.body;

    try {
        // Update Name and Client Code
        const stmt = db.prepare("UPDATE groups SET name = ?, client_code = ?, limit_tier = ? WHERE group_id = ?");
        stmt.run(name, client_code, limit_tier, group_id);
        
        console.log(`✅ Web Update: Modified ${name} (${group_id})`);
        res.redirect('/');
    } catch (err) {
        console.error("❌ Web Update Failed:", err);
        res.status(500).send("Error updating database.");
    }
});

// Handle Group Updates
app.post('/group/:id/update', express.urlencoded({ extended: true }), (req, res) => {
    try {
        const groupId = req.params.id;
        const { name, client_code, role, limit_tier } = req.body;

        const stmt = db.prepare(`
            UPDATE groups 
            SET name = ?, client_code = ?, role = ?, limit_tier = ?
            WHERE group_id = ?
        `);
        stmt.run(name, client_code, role, limit_tier, groupId);

        // Redirect back to the client list after saving
        res.redirect('/clients');
    } catch (err) {
        console.error("Update Error:", err);
        res.status(500).send("Failed to update group.");
    }
});

// ==========================================
// 🏨 VENDOR MAPPING ROUTES
// ==========================================

// ==========================================
// 🏢 VENDOR MANAGEMENT
// ==========================================

// 1. VIEW VENDORS PAGE
// ==========================================
// 🏨 GET: VENDOR MAPPING PAGE
// ==========================================
app.get('/vendors', requireAuth, (req, res) => {
    try {
        const { getDatabase } = require('./database');
        const db = getDatabase();
        
        // 1. Fetch only groups assigned as VENDORS
        const vendors = db.prepare("SELECT * FROM groups WHERE role = 'VENDOR'").all();
        
        // 2. Parse their handled_hotels arrays
        vendors.forEach(v => {
            try {
                v.handled_hotels = JSON.parse(v.handled_hotels) || [];
            } catch (e) {
                v.handled_hotels = [];
            }
        });

        // 3. 🛡️ NEW: Fetch the dynamic Golden Registry from the database
        let allHotels = [];
        try {
            const rows = db.prepare("SELECT name FROM hotel_registry ORDER BY name ASC").all();
            allHotels = rows.map(r => r.name);
        } catch (e) {
            console.error("Failed to fetch hotel registry for vendors page:", e);
        }

        // 4. Pass the vendors AND the dynamic hotel list to the EJS template
        res.render('vendors', { vendors, allHotels });

    } catch (err) {
        console.error("Error loading vendors:", err);
        res.status(500).send("Error loading vendors");
    }
});

// 2. ADD HOTEL TO VENDOR
// ==========================================
// 🏨 VENDOR MAPPING: ADD HOTELS (MULTI-SELECT UPGRADE)
// ==========================================
app.post('/vendor/:groupId/add-hotel', (req, res) => {
    const groupId = req.params.groupId;
    // 🛡️ The frontend will send a comma-separated list of hotels
    const hotelNamesRaw = req.body.hotel_names; 

    if (!hotelNamesRaw) return res.redirect('/vendors');

    try {
        const { getDatabase } = require('./database');
        const db = getDatabase();
        
        // 1. Get the current list
        const vendor = db.prepare("SELECT handled_hotels FROM groups WHERE group_id = ?").get(groupId);
        let handled = [];
        try { handled = JSON.parse(vendor.handled_hotels); } catch(e) {}

        // 2. Split the incoming comma-separated string into an array, clean it up
        const newHotels = hotelNamesRaw.split(',').map(h => h.trim()).filter(h => h.length > 0);

        // 3. Add them to the list (avoiding duplicates)
        newHotels.forEach(newHotel => {
            if (!handled.includes(newHotel)) {
                handled.push(newHotel);
            }
        });

        // 4. Save back to database
        db.prepare("UPDATE groups SET handled_hotels = ? WHERE group_id = ?")
          .run(JSON.stringify(handled), groupId);
          
    } catch (e) {
        console.error("Failed to add hotels to vendor:", e);
    }
    
    res.redirect('/vendors');
});

// 3. REMOVE HOTEL FROM VENDOR
app.post('/vendor/:id/remove-hotel', express.urlencoded({ extended: true }), (req, res) => {
    try {
        const { hotel_name } = req.body;
        const vendorId = req.params.id;
        const vendor = db.prepare("SELECT handled_hotels FROM groups WHERE group_id = ?").get(vendorId);
        
        if (vendor) {
            let hotels = [];
            try { hotels = JSON.parse(vendor.handled_hotels); } catch(e){}
            
            // Filter out the deleted hotel
            hotels = hotels.filter(h => h !== hotel_name);
            
            db.prepare("UPDATE groups SET handled_hotels = ? WHERE group_id = ?").run(JSON.stringify(hotels), vendorId);
        }
        res.redirect('/vendors');
    } catch (err) {
        console.error("Remove Hotel Error:", err);
        res.status(500).send("Failed to remove hotel.");
    }
});

// ==========================================
// 📋 HOTEL REGISTRY MANAGEMENT ROUTES
// ==========================================

// 1. View Registry
app.get('/registry', requireAuth, (req, res) => {
    const { getDatabase } = require('./database');
    const db = getDatabase();
    const hotels = db.prepare("SELECT * FROM hotel_registry ORDER BY name ASC").all();
    res.render('registry', { hotels });
});

// 1. GROUP DIRECTORY PAGE
app.get('/clients', requireAuth, (req, res) => {
    try {
        const groups = db.prepare("SELECT * FROM groups ORDER BY name ASC").all();
        const tiers = db.prepare("SELECT tier_name FROM limit_tiers").all();
        
        // 🌟 NEW: Fetch all unique markup tiers from the markup_rules table
        const markupTiers = db.prepare("SELECT DISTINCT client_code AS tier_name FROM markup_rules").all();
        
        res.render('clients', { groups, tiers, markupTiers });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading groups.");
    }
});


// 2. Add Hotel
app.post('/registry/add', express.urlencoded({ extended: true }), (req, res) => {
    const newHotel = (req.body.hotel_name || '').trim();
    if (newHotel) {
        try {
            const { getDatabase } = require('./database');
            const db = getDatabase();
            db.prepare("INSERT INTO hotel_registry (name) VALUES (?)").run(newHotel);
        } catch (e) {
            // Fails silently if duplicate
        }
    }
    res.redirect('/registry');
});

// 3. Remove Hotel
app.post('/registry/remove', express.urlencoded({ extended: true }), (req, res) => {
    const hotelId = req.body.hotel_id;
    if (hotelId) {
        const { getDatabase } = require('./database');
        const db = getDatabase();
        db.prepare("DELETE FROM hotel_registry WHERE id = ?").run(hotelId);
    }
    res.redirect('/registry');
});

// ==========================================
// 👥 POST: BULK UPDATE GROUPS 
// ==========================================
app.post('/groups/bulk-update', (req, res) => {
    try {
        const { getDatabase } = require('./database');
        const db = getDatabase();
        
        const ids = req.body.group_id || [];
        const names = req.body.group_name || []; // 🛡️ Grabs the edited names
        const codes = req.body.client_code || [];
        const roles = req.body.role || [];
        const tiers = req.body.limit_tier || [];

        const updateStmt = db.prepare(`
            UPDATE groups 
            SET name = ?, client_code = ?, role = ?, limit_tier = ?
            WHERE group_id = ?
        `);

        const transaction = db.transaction(() => {
            for (let i = 0; i < ids.length; i++) {
                const name = names[i] ? names[i].trim() : 'Unnamed Group';
                const code = codes[i] ? codes[i].trim() : '';
                const role = roles[i] ? roles[i].trim().toUpperCase() : 'NONE';
                const tier = tiers[i] ? tiers[i].trim() : 'DEFAULT';
                
                updateStmt.run(name, code, role, tier, ids[i]);
            }
        });

        transaction();
        res.redirect('/clients'); 
        
    } catch (e) {
        console.error("Bulk Update Error:", e);
        res.status(500).send("Failed to bulk update groups.");
    }
});
// ==========================================
// ⚙️ RULES & LIMITS MANAGEMENT
// ==========================================

// --- PROFIT MARKUPS ---

// 1. VIEW MARKUPS PAGE
app.get('/rules/markup', requireAuth, (req, res) => {
    try {
        const markups = db.prepare("SELECT * FROM markup_rules ORDER BY client_code ASC, min_price ASC").all();
        res.render('rules-markup', { markups });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading markups.");
    }
});

// 2. ADD/UPDATE TIER INSIDE A RULE
app.post('/rules/markup/add', express.urlencoded({ extended: true }), (req, res) => {
    const { client_code, min_price, max_price, markup_amount } = req.body;
    db.prepare(`
        INSERT INTO markup_rules (client_code, min_price, max_price, markup_amount) 
        VALUES (?, ?, ?, ?)
    `).run(client_code, min_price, max_price, markup_amount);
    res.redirect('/rules/markup');
});

// 3. DELETE ENTIRE RULE GROUP (e.g., all of VIP-B2B)
app.post('/rules/markup/delete-group/:tierName', (req, res) => {
    try {
        const tierName = req.params.tierName;
        if (tierName === 'DEFAULT') return res.status(400).send("Cannot delete the DEFAULT rule.");
        
        db.prepare("DELETE FROM markup_rules WHERE client_code = ?").run(tierName);
        res.redirect('/rules/markup');
    } catch (err) {
        res.status(500).send("Failed to delete the rule group.");
    }
});

// 4. DELETE SPECIFIC TIER ROW
app.post('/rules/markup/delete-tier/:id', (req, res) => {
    db.prepare("DELETE FROM markup_rules WHERE id = ?").run(req.params.id);
    res.redirect('/rules/markup');
});


// --- USAGE LIMITS ---

// 1. VIEW LIMITS PAGE
app.get('/rules/limits', requireAuth, (req, res) => {
    try {
        const limits = db.prepare("SELECT * FROM limit_tiers ORDER BY tier_name ASC").all();
        res.render('rules-limits', { limits });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading limits.");
    }
});

// 2. ADD OR UPDATE A LIMIT TIER
app.post('/rules/limits/upsert', express.urlencoded({ extended: true }), (req, res) => {
    try {
        const { tier_name, max_child, max_hotel, max_date, max_room, max_daily } = req.body;
        db.prepare(`
            INSERT INTO limit_tiers (tier_name, max_child_queries, max_hotels_per_date, max_date_ranges, max_room_types, max_daily_queries)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(tier_name) DO UPDATE SET
                max_child_queries = excluded.max_child_queries,
                max_hotels_per_date = excluded.max_hotels_per_date,
                max_date_ranges = excluded.max_date_ranges,
                max_room_types = excluded.max_room_types,
                max_daily_queries = excluded.max_daily_queries
        `).run(tier_name.toUpperCase(), max_child, max_hotel, max_date, max_room, max_daily || 30);
        res.redirect('/rules/limits');
    } catch (err) {
        res.status(500).send("Failed to save limit tier.");
    }
});

// 3. DELETE A LIMIT TIER
app.post('/rules/limits/delete/:name', (req, res) => {
    if (req.params.name !== 'DEFAULT') { // Prevent deleting the safety fallback
        db.prepare("DELETE FROM limit_tiers WHERE tier_name = ?").run(req.params.name);
    }
    res.redirect('/rules/limits');
});

// ==========================================
// 👨‍💼 EMPLOYEE MANAGEMENT
// ==========================================

// 1. VIEW EMPLOYEES & SCAN OWNER GROUPS DIRECTLY VIA WHATSAPP
app.get('/employees', requireAuth, async (req, res) => {
    try {
        const { getDatabase } = require('./database');
        const db = getDatabase();
        
        const employees = db.prepare("SELECT * FROM employees ORDER BY created_at DESC").all();
        // Check against the full JID (including @lid or @s.whatsapp.net)
        const existingJids = new Set(employees.map(e => e.jid));
        
        let suggestedStaff = new Set();
        const ownerGroups = db.prepare("SELECT group_id FROM groups WHERE role = 'OWNER'").all();
        
        if (globalSock) {
            for (const group of ownerGroups) {
                try {
                    const metadata = await globalSock.groupMetadata(group.group_id);
                    
                    for (const participant of metadata.participants) {
                        const rawId = participant.id || '';
                        const parts = rawId.split('@');
                        
                        if (parts.length === 2) {
                            // Strip device ID (e.g., :44) but KEEP the domain (@lid or @s.whatsapp.net)
                            const cleanNumber = parts[0].split(':')[0];
                            const domain = parts[1];
                            const cleanJid = `${cleanNumber}@${domain}`;
                            
                            if (!existingJids.has(cleanJid)) {
                                suggestedStaff.add(cleanJid);
                            }
                        }
                    }
                } catch (err) {
                    console.log(`⚠️ Could not fetch metadata for Owner Group: ${group.group_id}`);
                }
            }
        }

        res.render('employees', { 
            employees, 
            suggestedStaff: Array.from(suggestedStaff) 
        });
        
    } catch (err) {
        console.error("Error loading employees:", err);
        res.status(500).send("Error loading employees.");
    }
});

// 2. ADD OR UPDATE EMPLOYEE
// 2. ADD OR UPDATE EMPLOYEE
app.post('/employees/add', express.urlencoded({ extended: true }), (req, res) => {
    try {
        const { getDatabase } = require('./database');
        const db = getDatabase();
        const { name, jid } = req.body;
        
        let cleanJid = jid.trim();
        
        // If it was manually typed without a domain, assume it's a standard phone number
        if (!cleanJid.includes('@')) {
            cleanJid = cleanJid.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        }
        
        db.prepare(`
            INSERT INTO employees (jid, name) 
            VALUES (?, ?) 
            ON CONFLICT(jid) DO UPDATE SET name = ?
        `).run(cleanJid, name, name);
        
        res.redirect('/employees');
    } catch (err) {
        console.error("Error adding employee:", err);
        res.status(500).send("Failed to add employee.");
    }
});

// 3. DELETE EMPLOYEE
app.post('/employees/delete/:jid', (req, res) => {
    try {
        const { getDatabase } = require('./database');
        const db = getDatabase();
        // URL decode the JID because it contains '@'
        const targetJid = decodeURIComponent(req.params.jid);
        
        db.prepare("DELETE FROM employees WHERE jid = ?").run(targetJid);
        res.redirect('/employees');
    } catch (err) {
        console.error("Error deleting employee:", err);
        res.status(500).send("Failed to delete employee.");
    }
});

// ==========================================
// 🔍 VENDOR QUOTE ARCHIVE & SEARCH
// ==========================================
app.get('/archive', async (req, res) => {
    try {
        const { getDatabase } = require('./database');
        const db = getDatabase();

        // Populate Hotel Dropdown
        const uniqueHotels = db.prepare(`
            SELECT DISTINCT hotel_name FROM child_queries 
            WHERE hotel_name IS NOT NULL AND hotel_name != ''
            ORDER BY hotel_name ASC
        `).all();

        const { hotel, check_in, check_out, room_type, meal, view, stitch } = req.query;

        let results = [];
        let isHybrid = (stitch === 'true');

        if (hotel && check_in && check_out) {
            const { processLocalRates } = require('./v2/localRateEngine');
            
            // Setup query for the engine
            const mockQuery = { 
                hotel, 
                check_in, 
                check_out, 
                room_type: room_type || 'DOUBLE', 
                meal: meal || '',
                view: view || '',
                rooms: 1, 
                persons: 2,
                is_archive_test: true, // Prevents WA message sending
                force_stitch: isHybrid   // Forces stitching if checkbox is ticked
            };

            // Phase 1 & 2 logic handled inside the engine
            const data = await processLocalRates(mockQuery, null, null);
            if (data && Array.isArray(data)) {
                results = data;
            }
        }

        res.render('archive', { 
            uniqueHotels, 
            results, // Unified variable name
            filters: req.query,
            isHybrid 
        });
    } catch (err) {
        console.error("Archive Route Error:", err);
        res.status(500).send("Error loading archive: " + err.message);
    }
});

// ==========================================
// 📊 LOCAL RATE ENGINE: LIVE DATA VIEW
// ==========================================
app.get('/local-rates', (req, res) => {
    try {
        const { getDatabase } = require('./database');
        const db = getDatabase();

const rawQuotes = db.prepare(`
            SELECT 
                q.id,
                q.vendor_hotel_name,
                q.quoted_price,
                q.raw_reply_text,
                q.full_json,
                q.created_at,
                vr.vendor_group_id,
                g.name AS vendor_name,
                cq.check_in,
                cq.check_out,
                cq.room_type AS requested_room,
                pq.original_text AS client_original_text
            FROM vendor_quotes q
            LEFT JOIN vendor_requests vr ON q.request_id = vr.id     -- 🛡️ FIX: Changed to LEFT JOIN
            LEFT JOIN child_queries cq ON vr.child_id = cq.id        -- 🛡️ FIX: Changed to LEFT JOIN
            LEFT JOIN parent_queries pq ON cq.parent_id = pq.id 
            LEFT JOIN groups g ON vr.vendor_group_id = g.group_id
            ORDER BY q.created_at DESC
        `).all();

        const displayRates = rawQuotes.map(row => {
            let parsed = {};
            try { parsed = JSON.parse(row.full_json); } catch (e) {}

            // 🛡️ 1. BULLETPROOF ROOM TYPE
            let baseType = '';
            if (parsed.raw_vendor_data?.offered_room_type && parsed.raw_vendor_data.offered_room_type.trim() !== '') {
                baseType = parsed.raw_vendor_data.offered_room_type;
            } else if (parsed.raw_vendor_data?.quoted_base_capacity) {
                const capMap = {1: 'SINGLE', 2: 'DOUBLE', 3: 'TRIPLE', 4: 'QUAD', 5: 'QUINT'};
                baseType = capMap[parsed.raw_vendor_data.quoted_base_capacity] || `ROOM (${parsed.raw_vendor_data.quoted_base_capacity} PAX)`;
            } else {
                baseType = parsed.room_type || row.requested_room || 'ROOM';
            }

            // 🛡️ 2. BULLETPROOF AVERAGE RATE
            let averageRate = 0;
            if (Array.isArray(parsed.breakdown) && parsed.breakdown.length > 0) {
                const totalBase = parsed.breakdown.reduce((sum, day) => sum + (day.base_rate || day.net_daily || day.price || 0), 0);
                averageRate = Math.round(totalBase / parsed.breakdown.length);
            } else {
                averageRate = parsed.total_price || row.quoted_price || 0;
            }

            // 🛡️ 3. BULLETPROOF EXTRA BED
            let extraBedVal = 0;
            if (Array.isArray(parsed.raw_vendor_data?.split_rates) && parsed.raw_vendor_data.split_rates.length > 0) {
                const ebs = parsed.raw_vendor_data.split_rates.map(s => s.extra_bed_rate || 0);
                extraBedVal = Math.max(...ebs);
            }
            if (extraBedVal === 0) extraBedVal = parsed.raw_vendor_data?.extra_bed_price || 0;
            if (extraBedVal === 0) extraBedVal = parsed.extra_bed_price || 0;

            // 🛡️ 4. CLEAN HTML SPLITS (No complex grouping, just the raw splits)
            let displayRateHTML = "";
            if (Array.isArray(parsed.raw_vendor_data?.split_rates) && parsed.raw_vendor_data.split_rates.length > 1) {
                displayRateHTML = `
                    <div class="avg-rate">~${averageRate} SAR <span class="avg-label">(Avg)</span></div>
                    <details class="rate-details">
                        <summary>View Date Breakdown</summary>
                        <div class="rate-breakdown-content">
                `;
                parsed.raw_vendor_data.split_rates.forEach(s => {
                    let lbl = s.type === 'WEEKDAY' ? 'WD' : s.type === 'WEEKEND' ? 'WE' : (s.type || 'RATE');
                    let dts = s.dates ? s.dates.replace(/202[0-9]-/g, '') : '';
                    displayRateHTML += `<div class="rate-line"><span style="color:#64748b; font-size:10px;">${dts}</span> <b>${lbl}:</b> <strong>${s.rate} SAR</strong></div>`;
                });
                displayRateHTML += `</div></details>`;
            } else {
                const singleRate = parsed.raw_vendor_data?.split_rates?.[0]?.rate || averageRate;
                displayRateHTML = `<div class="avg-rate">${singleRate} SAR</div>`;
            }

            // 🛡️ 5. MEALS & VIEWS
            let mealText = parsed.applied_meal || parsed.raw_vendor_data?.base_meal_plan || 'RO';
            const mealSupp = parsed.meal_supplement || parsed.raw_vendor_data?.meal_price_per_pax || 0;
            if (mealSupp > 0) mealText += ` <span style="color:#e74c3c; font-size:10px; font-weight:bold;">(+${mealSupp})</span>`;

            let viewText = parsed.applied_view || 'Standard';
            let viewSupp = 0;
            const viewObj = parsed.raw_vendor_data?.view_surcharges;
            if (viewObj) {
               if (viewText.includes('HARAM') && viewObj.haram > 0) viewSupp = viewObj.haram;
               else if (viewText.includes('KAABA') && viewObj.kaaba > 0) viewSupp = viewObj.kaaba;
               else if (viewText.includes('CITY') && viewObj.city > 0) viewSupp = viewObj.city;
            }
            if (viewSupp === 0 && parsed.view_supplement > 0) viewSupp = parsed.view_supplement;
            if (viewSupp > 0) viewText += ` <span style="color:#e74c3c; font-size:10px; font-weight:bold;">(+${viewSupp})</span>`;

            const dateObj = new Date(row.created_at);
            const formattedDate = `${dateObj.toLocaleDateString('en-GB')}<br><span style="color:#94a3b8; font-size:10px;">${dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</span>`;

            return {
                rawTimestamp: dateObj.getTime(),
                rawPrice: averageRate,
                rawCheckIn: row.check_in || '',    
                rawCheckOut: row.check_out || '',  
                submissionDateHTML: formattedDate,
                stayDates: `${row.check_in || '?'} to ${row.check_out || '?'}`,
                hotel: row.vendor_hotel_name || parsed.hotel || 'Unknown',
                baseType: baseType.toUpperCase(),
                displayRateHTML: displayRateHTML, 
                extraBed: extraBedVal,
                meal: mealText,
                view: viewText,
                descriptor: parsed.room_descriptor || '-',
                vendor: row.vendor_name || row.vendor_group_id || 'Unknown Vendor',
                clientText: row.client_original_text || 'No client text available',
                rawText: row.raw_reply_text || 'No text recorded',
                rawJson: row.full_json || '{}',
                // 🛡️ NEW: URL-encoded JSON for the frontend Stitcher Engine
                encodedJson: encodeURIComponent(row.full_json || '{}')
            };
        });

        res.render('local_rates', { rates: displayRates });
    } catch (err) {
        console.error("Local Rates Route Error:", err);
        res.status(500).send("Error loading local rates.");
    }
});

// ==========================================
// 🛠️ DATABASE DIAGNOSTICS
// ==========================================
app.get('/db-stats', (req, res) => {
    try {
        const { getDatabase } = require('./database');
        const db = getDatabase();

        const stats = {
            parent_queries: db.prepare("SELECT COUNT(*) as count FROM parent_queries").get().count,
            child_queries: db.prepare("SELECT COUNT(*) as count FROM child_queries").get().count,
            vendor_requests: db.prepare("SELECT COUNT(*) as count FROM vendor_requests").get().count,
            vendor_quotes: db.prepare("SELECT COUNT(*) as count FROM vendor_quotes").get().count,
            groups: db.prepare("SELECT COUNT(*) as count FROM groups").get().count,
        };

        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 📱 WA CONNECTION MANAGER API
// ==========================================
app.get('/api/bot-status', (req, res) => {
    res.json({
        status: globalBotStatus,
        qr: globalQR
    });
});

app.post('/api/bot-reset', async (req, res) => {
    console.log("🛑 Manual Reset Triggered via Web Dashboard");
    globalBotStatus = 'RESTARTING';
    globalQR = null;

    // 1. Destroy current connection
    if (globalSock) {
        globalSock.ev.removeAllListeners();
        try { globalSock.logout(); } catch(e) {}
        try { globalSock.ws.close(); } catch(e) {}
        globalSock = null;
    }

    // 2. Wait 1.5 seconds for file locks to release, then delete the auth folder
    setTimeout(() => {
        try {
            // Force delete the folder. Assumes index.js is running from the bot root.
            const authPath = path.resolve('./auth_main'); 
            fs.rmSync(authPath, { recursive: true, force: true });
            console.log("🗑️ Auth folder deleted successfully.");
        } catch (e) {
            console.error("⚠️ Failed to delete auth folder:", e.message);
        }

        // 3. Restart the bot
        startBot();
    }, 1500);

    res.json({ success: true, message: "Bot is restarting and generating new QR..." });
});

// ==========================================
// 🚀 SERVER START
// ==========================================
const PORT = process.env.PORT || 3000;

// Adding '0.0.0.0' is the magic key for Termux to Laptop connections
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Dashboard globally accessible on port ${PORT}`);
});