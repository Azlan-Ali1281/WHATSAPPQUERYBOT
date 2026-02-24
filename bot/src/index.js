const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const { processLocalRates } = require('./v2/localRateEngine');

const { initDatabase } = require('./database');

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
    getQuoteByReqId // 👈 ADD THIS
} = require('./database');

// ✅ CORRECT (Relative to index.js)
const { calculateQuote } = require('./v2/calculator');
const { formatForOwner } = require('./v2/formatter');


const qrcode = require('qrcode-terminal')

const { segmentClientQuery } = require('./aiBlockSegmenter')
const { parseClientMessageWithAI } = require('./aiClientParser')
const { classifyMessage } = require('./messageClassifier')
const { isEmployee } = require('./employeeConfig')
const { sanitizeHotelNames } = require('./aiSanitizer');

const {
  getGroupRole,
  getVendorsForHotel,
  getOwnerGroups,
  getClientCode
} = require('./groupConfig')

// ======================================================
// 🛡️ SAFETY LIMITS (Circuit Breaker)
// ======================================================
const LIMITS = {
  MAX_TOTAL_REQUESTS: 6, // Hard cap: No more than 15 vendor msgs per user msg
  MAX_DATE_RANGES: 3,     // Max distinct date ranges (e.g. 1-5 Feb, 10-12 Feb...)
  MAX_HOTELS: 4,          // Max distinct hotels per query
  MAX_ROOM_TYPES: 2,       // Max distinct room types per hotel
  MAX_VENDORS_PER_HOTEL: 6 // 🛡️ NEW: How many vendors get the blast?
};

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
        if (type === 'P') result = recallLastParentQueries(count);
        else result = recallLastChildQueries(count);

        let delCount = 0;
        
        // Loop through and command WhatsApp to "Delete for Everyone"
        for (const m of result.messages) {
            try {
                await sock.sendMessage(m.vendor_group_id, { 
                    delete: { remoteJid: m.vendor_group_id, fromMe: true, id: m.sent_message_id } 
                });
                delCount++;
                await sleep(300); // Wait 300ms between deletes so WhatsApp doesn't block the bot
            } catch (e) {
                console.log(`⚠️ Failed to delete msg in ${m.vendor_group_id}`);
            }
        }

        const report = type === 'P' 
            ? `✅ *RECALL COMPLETE*\n\n🗑️ Deleted ${result.pDeleted} Parent Queries\n🗑️ Deleted ${result.cDeleted} Child Queries\n💬 Recalled ${delCount} Vendor Messages.`
            : `✅ *RECALL COMPLETE*\n\n🗑️ Deleted ${result.cDeleted} Child Queries\n💬 Recalled ${delCount} Vendor Messages.`;

        await sock.sendMessage(groupId, { text: report }, { quoted: msg });

    } catch (err) {
        console.error("Recall Error:", err);
        await sock.sendMessage(groupId, { text: "❌ Database error during deletion." }, { quoted: msg });
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
  const badPatterns = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|tripl|oct|nov|dec|again|check|plz|please|pax|room|triple|quad|double|booking|nights|date|ashra)\b/i;
  if (badPatterns.test(h)) return null;

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
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({ auth: state, version })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ qr, connection }) => {
    if (qr) qrcode.generate(qr, { small: true })
    if (connection === 'open') console.log('✅ Bot connected')
  })

    sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const senderId = msg.key.participant || msg.key.remoteJid;
    const groupId = msg.key.remoteJid;
    const rawText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

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
    if (!groupId?.endsWith('@g.us')) {
        // Only reply if they actually sent some text, to avoid spamming system events
        if (rawText.trim()) {
            const autoReply = `*Salam! 👋*

Main HBA Travel & Tours ka B2B Umrah Query Bot hoon, jise HBA Group ne develop kiya hai. 

*🤖 Main Kaisay Kaam Karta Hoon:*
Jab koi client group mein Umrah hotel ki query bhejta hai, main AI aur rules ke zariye usay samajhta hoon. Phir usay format kar ke vendors ko bhejta hoon (ya saved rates ka direct reply karta hoon). Vendor ke reply aane par, main rates calculate aur compare kar ke final quote client ko bhej deta hoon.

*⚠️ Status:* Main abhi development phase mein hoon, is liye agar koi issue aaye toh zaroor batayein.

📞 *Contacts:*
• *Queries/Rates Issues:* Reservation Manager, Anas Ali  +923326873756 
• *Bot Details/Bug Reports:* Developer, Azlan Ali  +923162724750 

*(Main sirf designated groups mein kaam karta hoon aur direct messages ka reply nahi kar sakta. Shukriya!)*

---

*Salam! 👋*

I am the B2B Umrah Query Bot for HBA Travel & Tours, developed by HBA Group.

*🤖 How I Work:*
When a client sends a hotel query in the group, I use AI and custom rules to process it. I then format and forward it to relevant vendors (or instantly reply with saved rates). Once a vendor replies, I analyze, calculate, and compare the rates before sending the final quote back to the client.

*⚠️ Status:* I am currently in the development phase, so you might encounter some minor issues. 

📞 *Contacts:*
• *Queries/Rates Issues:* Reservation Manager, Anas Ali  +923326873756 
• *Bot Info/Bug Reports:* Developer, Azlan Ali  +923162724750 

*(I only operate inside designated WhatsApp groups and cannot process direct messages. Thank you!)*`;

            await sock.sendMessage(groupId, { text: autoReply });
        }
        return; // Stop processing so it doesn't trigger the rest of the bot
    }

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

    const role = getGroupRole(groupId);

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

    // Now it is safe to block employees from sending normal hotel queries
    if (isEmployee(senderId)) return 

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
      // 🛡️ 1. ROBUST PRE-PROCESSING
      // ============================================================
    // ✅ STEP A: Fix Typos & Normalize
      let preProcessedText = finalProcessingText
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
        
        // 🛡️ FIX: KILL ZIP CODES (Prevents "Swiss 21955" from being deleted later)
        .replace(/\b\d{5}\b/g, ' ') 
        
        // 🛡️ FIX: KILL GENERIC TERMS (Prevents "Fundaq" from being seen as a hotel)
        .replace(/\b(fundaq|fudnaq)\b/gi, ' ')
        
        // Standardize to "LAST ASHRA" so the AI recognizes it easily
        .replace(/\b(last\s*ashra|last\s*10\s*days\s*of\s*ramadan|last\s*ashrah)\b/gi, 'LAST ASHRA')
        
        // Fix "1st of March" -> "1 March"
        .replace(/(\d+)(?:st|nd|rd|th)?\s+of\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi, '$1 $2')
        .replace(/(\d+)(st|nd|rd|th)/gi, '$1')

        // Fix "1st of March" -> "1 March"
        .replace(/(\d+)(?:st|nd|rd|th)?\s+of\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi, '$1 $2')
        .replace(/(\d+)(st|nd|rd|th)/gi, '$1')

        // 🛡️ FIX 27: COMPRESSED DATE NORMALIZER (e.g. 28mar-04apr -> 28 mar to 04 apr)
        .replace(/(\d{1,2})(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi, '$1 $2')
        .replace(/(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\s*-\s*(\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)/gi, '$1 to $2')

        // 🛡️ FIX 26: HYPHEN DATE NORMALIZER

        // 🛡️ FIX 26: HYPHEN DATE NORMALIZER
        .replace(/(\d{1,2})[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-]*(\d{2})\b/gi, '$1 $2 20$3')
        .replace(/(\d{1,2})[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s-]*(\d{4})\b/gi, '$1 $2 $3')

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
      // REMOVED: manar, madinah, khalil (to protect "Emaar Al Manar", "Anwar Madinah")
      // KEPT: hidayah, miramar, concord, vision (Stand-alone names)
      const brandsRegex = /\b(hilton|swiss|voco|pullman|anwar|saja|kiswa|movenpick|fairmont|rotana|emaar|dar|tawhid|conrad|sheraton|marriott|le meridien|clock|royal|majestic|safwah|shaza|millennium|oberoi|miramar|hidayah|hidaya|iman|harmony|leader|mubarak|wissam|concord|vision|ruve|nozol|diafa|shourfah)\b/gi;
      preProcessedText = preProcessedText.replace(brandsRegex, '\n$1');

      // 🛡️ FIX 8: THE EXPLODER
      preProcessedText = preProcessedText.replace(
          /(?<!\bto\s*)(?<!-\s*)(?<!\bfrom\s*)(\b\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)/gi, 
          '\n$1 '
      );
      
      preProcessedText = preProcessedText.replace(
          /(\b\d+\s*(?:room|bed|pax|guest|dbl|double|trp|triple|quad|qued|quint|suite))/gi,
          '\n$1'
      );

      // ✅ STEP B: Run the Multi-Line Date Fixer
      preProcessedText = normalizeMultiLineDateRange(preProcessedText);

      // ✅ STEP C: Standard replacements
      // ... (Keep the rest of your Step C regexes here exactly as they were) ...
      preProcessedText = preProcessedText
        .replace(/(\d{1,2})\s*[\/-]\s*(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi, '$1 to $2 $3')
        .replace(/\b(\d{1,2})[\/-](\d{1,2})\b/g, (match, d, m) => {
            if (parseInt(m) > 12) return `${d} to ${m}`; 
            const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            return `${d} ${months[parseInt(m)-1]}`;
        })
        .replace(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/g, (m, d, mth, y) => {
             const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
             return `${d} ${months[parseInt(mth)-1]} ${y}`;
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
      let requestCount = 0;
      let limitReached = false;

      let totalUniqueHotels = new Set();
      blocks.forEach(b => {
          (b.hotels || []).forEach(h => totalUniqueHotels.add(h.toLowerCase()));
      });
      
      if (totalUniqueHotels.size > LIMITS.MAX_HOTELS) {
          for (const owner of getOwnerGroups()) {
              await sock.sendMessage(owner, { text: `⚠️ *SAFETY WARNING*: Query has ${totalUniqueHotels.size} hotels (Limit: ${LIMITS.MAX_HOTELS}). Limiting output.` });
          }
      }

      blockLoop: for (const block of blocks) {
        if (limitReached) break blockLoop;

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

        if (blockDateList.length > LIMITS.MAX_DATE_RANGES) {
             blockDateList = blockDateList.slice(0, LIMITS.MAX_DATE_RANGES);
        }

        if (blockDateList.length === 0 && globalDateRanges.length > 0) blockDateList = globalDateRanges;

        let splitHotels = [];
        (block.hotels || []).forEach(h => {
             splitHotels.push(...h.split(/\s*\/\s*|\s+or\s+|\s*&\s*|,\s*|\n/i).map(s => s.trim()).filter(Boolean));
        });
        
        if (splitHotels.length > LIMITS.MAX_HOTELS) splitHotels = splitHotels.slice(0, LIMITS.MAX_HOTELS);
        

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
            const matchedName = rawSanitizedResults[index];
            
            // Search the ORIGINAL text lines to find stripped keywords
            const originalLine = originalLines.find(ol => ol.toLowerCase().includes(raw.toLowerCase())) || raw;const hasStrongKeyword = /hotel|fundaq|fandaq|saif|majd|dar|tower|inn|suites|stay|voco|pullman|swiss|hilton|meridien|emaar|royal|fairmont|zamzam|makkah|nabras|nebras|taiba|sky\s*view/i.test(originalLine);
            
            // Validation Gate Logic: Keep if DB match OR strong keyword
            if (matchedName || (hasStrongKeyword && raw.length > 3)) {
                const finalName = matchedName || raw; 
                sanitizedHotels.push(finalName);
                finalSanitizedMap[raw] = finalName;
            } else {
                console.log(`🗑️ Dropping non-hotel junk: "${raw}"`);
            }
        });

        // 2. Remove Duplicates & Maintain "Again/Same" logic
        sanitizedHotels = [...new Set(sanitizedHotels)];

        const isAgain = rawText.toUpperCase().includes('AGAIN') || rawText.toUpperCase().includes('SAME');
        if ((sanitizedHotels.length === 0 || (sanitizedHotels.length === 1 && /AGAIN|SAME/i.test(sanitizedHotels[0]))) && isAgain) {
           if (lastKnownHotels.length > 0) sanitizedHotels = lastKnownHotels;
        } else {
           const validNow = sanitizedHotels.map(h => normalizeHotelForAI(h)).filter(Boolean);
           if (validNow.length > 0) lastKnownHotels = validNow;
        }

        // 3. Process the Loop
        for (const hotelName of sanitizedHotels) {
          if (limitReached) break blockLoop;

          const hotel = normalizeHotelForAI(hotelName);
          if (!hotel) continue;

          // 🛡️ Use our cleaned finalSanitizedMap to find what the user actually typed
          const rawNameInText = Object.keys(finalSanitizedMap).find(key => finalSanitizedMap[key] === hotelName) || hotelName;

          // Now we search the text using the raw name, not the clean one!
          const fullLine = effectiveText.split('\n').find(l => l.toLowerCase().includes(rawNameInText.toLowerCase())) || rawNameInText;
          
          let activeTypes = extractRoomTypesFromText(fullLine);
          if (activeTypes.length === 0) activeTypes = universalTypes;
          
          if (activeTypes.length > LIMITS.MAX_ROOM_TYPES) activeTypes = activeTypes.slice(0, LIMITS.MAX_ROOM_TYPES);

          const mealHint = extractMeal(effectiveText);
          const viewHint = extractView(effectiveText);

          const allContextDates = [...new Set([...blockDateList, ...globalDateRanges])];          
          // ... rest of your AI call logic ...// 🛡️ SMART CONTEXT PROMPT
const aiInput = protectDoubleTreeHotel([
              `### TARGET HOTEL: ${hotel} (Identified in text as "${rawNameInText}")`,
              `### MESSAGE CONTEXT: \n${effectiveText}`, 
              `### DEFAULTS: Meal=${mealHint}, View=${viewHint}, Rooms=1`,
              
              `--- EXTRACTION PROTOCOL (DO NOT IGNORE) ---`,
              `1. THE ADJACENCY RULE: Usually, a hotel's date is IMMEDIATELY ABOVE or BELOW its name.`,
              `2. MULTIPLE DATE OPTIONS: If the text lists multiple alternative dates for this hotel, you MUST create a SEPARATE query object in your array for EACH date range!`,
              `3. THE "STEALING" TRAP: Never give Date A to Hotel B if they are separated by another hotel's name.`,
              `4. THE BARRIER RULE: Another hotel's name is a WALL. You cannot "jump over" it to find a date.`,
              `5. LIST / HEADER EXCEPTION (OVERRIDES BARRIER RULE): If there is a date at the top and a list of hotels below it (e.g., 1. Hotel A, 2. Hotel B), apply that top date to ALL hotels in the list!`,
              `6. DATE MATH & FORMATS: "15 20 mar" = Check-in 15 Mar, Check-out 20 Mar.`,
              `7. PAX & ROOM LOGIC: If text says "6 persons", use 6. OTHERWISE: Triple = 3, Quad = 4, Double/Twin = 2.`,
              `8. MEALS & VIEWS: Use the hints (${mealHint}/${viewHint}) as defaults. ONLY change them if the text explicitly says otherwise.`,
              `9. ISOLATION: Return data for "${hotel}" ONLY.`,
              
              `STRICT OUTPUT: Return ONLY a JSON object with the 'queries' array.`
          ].join('\n'));

          let ai;
          try { 
              ai = await parseClientMessageWithAI(aiInput); 
          } catch (err) { continue; }
          if (!ai?.queries) continue;

          for (const qRaw of ai.queries) {
              if (requestCount >= LIMITS.MAX_TOTAL_REQUESTS) {
                  limitReached = true;
                  break blockLoop;
              }

              const q = { ...qRaw };
              if (!normalizeHotelForAI(q.hotel)) q.hotel = hotel;

              

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
      
      if (limitReached) {
          for (const owner of getOwnerGroups()) {
              await sock.sendMessage(owner, { 
                  text: `⚠️ *SAFETY BREAKER TRIPPED*\n\n📍 Group: ${groupId}\n\n🛑 Request limit of ${LIMITS.MAX_TOTAL_REQUESTS} hit.\n✅ Auto-processed first ${LIMITS.MAX_TOTAL_REQUESTS} queries.\n⚠️ Remaining items ignored. Please check manually.` 
              });
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
              
              // Sort by Scarcity
              const hotelOps = uniqueHotels.map(hotel => {
                  return { 
                      hotel, 
                      vendors: getVendorsForHotel(hotel) 
                  };
              }).sort((a, b) => a.vendors.length - b.vendors.length);

              // Assign Vendors
              for (const op of hotelOps) {
                  const { hotel, vendors } = op;
                  
                  const hotelQueries = queries.filter(q => q.hotel === hotel);
                  if (hotelQueries.length === 0) continue;

                  const availableVendors = vendors.filter(v => !usedVendorsForThisDate.has(v));
                  const selectedVendors = availableVendors.slice(0, LIMITS.MAX_VENDORS_PER_HOTEL);

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
                          
                          const clientCode = getClientCode(groupId) || 'REQ';

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
                // 🛡️ THE RAW RESCUE: Improved with Price & Room Filter
                if (!newHotel) {
                    // 🛡️ THE FIX: Strip out conversational words FIRST!
                    // If we don't do this first, isJunkLine() sees "offer" and kills it instantly.
                    let firstLine = potentialLines[0].replace(/can offer|we have|available|offering|how about|we can give|offer/ig, '').trim();
                    
                    // Check if the cleaned line looks like a price or room type
                    const isPriceLine = /\d+\/\d+/.test(firstLine) || /@\s*\d+/.test(firstLine) || /^\d+$/.test(firstLine.replace(/[^\d]/g, ''));
                    const isRoomCode = /dbl|trp|quad|sgl|ro|bb|hb|fb/i.test(firstLine) && /\d+/.test(firstLine);
                    
                    // 🛡️ Heavily expanded junk word list
                    const isVendorJunk = /booked|sold|out|stop|sale|unavailable|w\.e|weekend|extra|ex\b|recheck|before|final|list|check|please|kindly|wait|let me|checking|dear/i.test(firstLine);
                    
                    // Now test the CLEANED name (which will just be "miramar")
                    if (firstLine.length >= 3 && !isJunkLine(firstLine) && !isVendorJunk && !isPriceLine && !isRoomCode && firstLine.split(/\s+/).length <= 5) {
                        newHotel = firstLine; 
                        console.log(`⛑️ Vendor Hotel Rescued (Raw Text): "${newHotel}"`);
                    } else {
                        console.log(`🚫 Rescue Skipped: Line "${firstLine}" looks like a price or room code (or junk).`);
                        // Fallback to the hotel name we originally asked for
                        newHotel = context.requested_hotel;
                    }
                }
                  
                if (newHotel && newHotel.toLowerCase() !== actualHotel.toLowerCase()) {
                    console.log(`🔄 Hotel Override Detected: "${actualHotel}" -> "${newHotel}"`);
                    actualHotel = newHotel;
                }
            } // <-- THIS BRACKET WAS LIKELY MISSING OR MISPLACED

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
              const owners = getOwnerGroups();
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
  sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'close') {
      console.log('❌ Connection closed, restarting...')
      startBot()
    }
  })
}

startBot()