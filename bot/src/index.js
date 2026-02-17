const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')

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
  getOwnerGroups
} = require('./groupConfig')

// ======================================================
// 🛡️ SAFETY LIMITS (Circuit Breaker)
// ======================================================
const LIMITS = {
  MAX_TOTAL_REQUESTS: 6, // Hard cap: No more than 15 vendor msgs per user msg
  MAX_DATE_RANGES: 3,     // Max distinct date ranges (e.g. 1-5 Feb, 10-12 Feb...)
  MAX_HOTELS: 4,          // Max distinct hotels per query
  MAX_ROOM_TYPES: 1,       // Max distinct room types per hotel
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
  const paxPatterns = [
    { reg: /\b(1\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE|BED|BEDS|PPL|PEOPLES))\b/i, type: 'SINGLE' },
    { reg: /\b(2\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE|BED|BEDS|PPL|PEOPLES))\b/i, type: 'DOUBLE' },
    { reg: /\b(3\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE|BED|BEDS|PPL|PEOPLES))\b/i, type: 'TRIPLE' },
    { reg: /\b(4\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE|BED|BEDS|PPL|PEOPLES))\b/i, type: 'QUAD' },
    { reg: /\b(5\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE|BED|BEDS|PPL|PEOPLES))\b/i, type: 'QUINT' }
  ];

  paxPatterns.forEach(p => {
    if (p.reg.test(t)) types.push(p.type);
  });

  // 3. 🏠 STANDARD TYPES & SHORTHAND (Fallback + PLURAL SUPPORT 'S')
// 3. 🏠 STANDARD TYPES & SHORTHAND (Fallback + PLURAL SUPPORT 'S')
  // Added (?:S?) to handle "SINGLES", "DOUBLES", "TRIPLES", "QUADS"
  if (/\bSINGLE(?:S?)\b/i.test(t)) types.push('SINGLE');
  if (/\b(DBL|DOUBLE|DUBLE|TWIN)(?:S?)\b/i.test(t)) types.push('DOUBLE');
  if (/\b(TPL|TRP|TRIPLE|TRIPPLE|TRIPAL)(?:S?)\b/i.test(t)) types.push('TRIPLE'); 
  
  // 🛡️ FIX: Removed double pipe "||" which caused "Ghost Quad" bug
  // Was: QD||QUED (Matched empty string) -> Now: QD|QUED
  if (/\b(QUAD|QUARD|QAD|QUADR|QD|QUED)(?:S?)\b/i.test(t)) types.push('QUAD'); 
  
  if (/\b(QUINT|QUINTU|QUINTUPLE)(?:S?)\b/i.test(t)) types.push('QUINT');
  
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
  if (/\b(SUHOOR|SUHUR|SEHRI|SAHRI|SEHRY)\b/.test(t)) return 'SUHOOR';
  if (/\b(IFTAR|IFTARI|AFTARI|IFTAAR)\b/.test(t)) return 'IFTAR';
  
  // 🏨 STANDARD MEALS
  if (/\b(BB|BREAKFAST|BF)\b/.test(t)) return 'BB';
  if (/\b(RO|ROOM ONLY|ROOMONLY|ONLY ROOM|ROOMONLEY)\b/.test(t)) return 'RO';
  if (/\b(HB|HALF BOARD|HALFBOARD)\b/.test(t)) return 'HB';
  if (/\b(FB|FULL BOARD|FULLBOARD)\b/.test(t)) return 'FB';
  
  return '';
}

function extractView(text = '') {
  const t = text.toLowerCase();
  
  // 🕌 PREMIER / PRIME VIEWS
  // Handles: "Premier Kaaba", "Preimer Kaba", "Prime Haram"
  if (/\b(premier|preimer|prime|prm)\s*(kaaba|kaba|kabah|kbah)\b/.test(t)) return 'PREMIER KAABA VIEW';
  if (/\b(premier|preimer|prime|prm)\s*(haram|harem|harum)\b/.test(t)) return 'PREMIER HARAM VIEW';

  // 🌓 PARTIAL VIEWS
  // Handles: "Partial Kaaba", "Side Haram", "Semi Kaba"
  if (/\b(partial|part|side|semi)\s*(kaaba|kaba|kabah|haram|harem)\b/.test(t)) return 'PARTIAL KAABA VIEW';

  // 🕋 STANDARD VIEWS
  if (/\b(kaaba|kaba|kabah|kbah)\b/.test(t)) return 'KAABA VIEW';
  if (/\b(haram|harem|harum)\b/.test(t)) return 'HARAM VIEW';
  if (/\b(city|street)\b/.test(t)) return 'CITY VIEW';
  
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
  // (Your existing list handles hidayah/miramar/etc)
  const hotelBrands = /\b(hilton|swiss|voco|pullman|anwar|saja|kiswa|tower|hotel|movenpick|fairmont|rotana|emaar|dar|tawhid|conrad|sheraton|marriott|le meridien|clock|royal|majestic|safwah|ghufran|shaza|millennium|copthorne|taiba|front|aram|artal|zn|fundaq|grand|oberoi|miramar|hidayah|hidaya|manar|iman|harmony|leader|mubarak|wissam|concord|vision|ruve|nozol|diafa|shourfah)\b/i;
  
  // 🚨 CRITICAL FIX: "LAST ASHRA" is a DATE, NEVER a hotel.
  // We check this BEFORE the whitelist so Emaar doesn't save it.
  if (/last\s*ashra|ramadan/i.test(t)) return true;

  if (hotelBrands.test(t)) return false;

  // 🛡️ 1. NUMBER START GUARD (Fixes "1 dbl with extra bed")
  // Added: qued
    if (/^\d/.test(t) && /\b(dbl|double|trp|triple|quad|qued|quint|bed|pax|room|guest|night|sharing|person|persons)\b/i.test(t)) {
      return true;
  }

  // 2. DATES
  if (/(\d{1,2})[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true;
  if (/check\s*(in|out)|arr|dep|from|to/i.test(t)) return true;

  // 3. KEYWORD DICTIONARY
  // Added: qued
  // 3. KEYWORD DICTIONARY
  // Added: person (singular)
  const roomLock = /\b(single|double|dbl|twin|triple|trp|tripple|quad|qued|quard|quart|qad|qud|quadr|quint|hex|hexa|suite|room|rooms|persons|person|bed|beds|view|veiw|vew|city|haram|kaaba|ro|bb|hb|fb|breakfast|extra|sharing)\b/i;

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

  // 🛡️ 1. HARD BLOCK: Hallucinations (Dates/Filler)
  // Added: ashra
  const badPatterns = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|again|check|plz|please|pax|room|triple|quad|double|booking|nights|date|ashra)\b/i;
  if (badPatterns.test(h)) return null;

  // 🛡️ 2. DATE & NUMBER BLOCKER
  if (/^\d{1,2}[\/\-]\d{1,2}/.test(h)) return null;
  if (/^[\d\s\-\/\.]+$/.test(h)) return null;
  if (h.length < 3) return null;
  if (/^hotel$/i.test(h)) return null;

  // 🛡️ 3. BRAND PROTECTION
  h = h.replace(/\b(double|dbl)\s*tree\b/gi, 'DoubleTree');
  h = h.replace(/\b(fundaq|fudnaq)\b/gi, '');

  // 🛡️ 4. HOTEL KEYWORD LIST
  // Added: hidayah (variations), concord, vision, jiwar, wahba, shourfah, etc.
  // 🛡️ 4. HOTEL KEYWORD LIST
  // Added: hidayah (variations), miramar, ruve, nozol, etc.
  const hotelKeywords = /\b(hotel|inn|suites|lamar|emaar|jabal|tower|towers|palace|movenpick|hilton|rotana|front|manakha|nebras|view|residence|grand|plaza|voco|sheraton|accor|pullman|anwar|dar|taiba|saja|emmar|andalusia|royal|shaza|millennium|ihg|marriott|fairmont|clock|al|bakka|retaj|rawda|golden|tulip|kiswa|kiswah|khalil|safwat|madinah|convention|tree|doubletree|fundaq|bilal|elaf|kindi|bosphorus|zalal|nuzla|matheer|artal|odst|zowar|miramar|ruve|nozol|diafa|shourfah|manar|iman|harmony|leader|mubarak|wissam|concord|vision|hidayah|hidaya|hedaya)\b/i;
  // 🛡️ NOISE CLEANER
// Added: qued
  h = h.replace(/\b(single|double|dbl|twin|triple|trp|tripple|quad|qued|quard|room|only|bed|breakfast|bb|ro)\b/gi, '').trim();

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
    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    const senderId = msg.key.participant || msg.key.remoteJid
    if (isEmployee(senderId)) return

    const groupId = msg.key.remoteJid
    if (!groupId?.endsWith('@g.us')) return

    const rawText =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''

    if (!rawText.trim()) return

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

    const role = getGroupRole(groupId)
    const type = classifyMessage({ groupRole: role, text: finalProcessingText })
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
        .replace(/\bcheck\s*inn\b/gi, 'check in') 
        .replace(/\b(inn|out)\s*:\s*/gi, ' ')     
        .replace(/\b(guest|name)\s*:\s*/gi, 'guest ')
// 🛡️ FIX 4: CHATTER CLEANER
        .replace(/\b(salam|bhai|hi|hello|dear|sir|madam|please|plz|kindly|need|want|booking|rates|check|price|prices|amount|cost)\b/gi, ' ')
        
        // 🛡️ FIX: KILL ZIP CODES (Prevents "Swiss 21955" from being deleted later)
        .replace(/\b\d{5}\b/g, ' ') 
        
        // 🛡️ FIX: KILL GENERIC TERMS (Prevents "Fundaq" from being seen as a hotel)
        .replace(/\b(fundaq|fudnaq)\b/gi, ' ')
                // Fix "1st of March"
        // Standardize to "LAST ASHRA" so the AI recognizes it easily
        .replace(/\b(last\s*ashra|last\s*10\s*days\s*of\s*ramadan|last\s*ashrah)\b/gi, 'LAST ASHRA')
        .replace(/(\d+)(?:st|nd|rd|th)?\s+of\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi, '$1 $2')
        .replace(/(\d+)(st|nd|rd|th)/gi, '$1')

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
              const pureDate = /^(\d{1,2}(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i.exec(line);
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
      
      if (blocks.length === 0) {
        for (const owner of getOwnerGroups()) {
          await sock.sendMessage(owner, { text: '⚠️ No valid booking blocks detected' });
        }
        return;
      }

      const parent = createParent({ clientGroupId: groupId, originalMessage: msg });
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
      
      let sanitizedMap = {};
      if (globalHotels.length > 0) {
          console.log("🧹 Sanitizing hotels:", globalHotels);
          const cleaned = await sanitizeHotelNames(globalHotels);
          console.log("✅ Result:", cleaned);
          
          globalHotels.forEach((raw, i) => { 
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
      const hasDate = /(\d{1,2})\s*(?:to|-)?\s*(\d{1,2})?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(effectiveText) || 
                      /last\s*ashra|ramadan/i.test(effectiveText);

      // 🛡️ FIX: Added SUITE, STUDIO, FAMILY to room detection
      const hasRoom = /\b(sgl|single|dbl|double|tw|twin|trp|triple|tripple|quad|quard|qad|qued|quint|pax|bed|room|guest|person|prsn|ppl|suite|studio|family)s?\b/i.test(effectiveText);
      
      if (!hasRoom && hasDate) {
          setPendingQuestion(groupId, { originalText: effectiveText, missing: 'ROOM' });
          await sock.sendMessage(groupId, { text: "Which *Room Type*? (e.g. Double, Triple)" }, { quoted: msg });
          return;
      }
      if (!hasDate && hasRoom) {
          setPendingQuestion(groupId, { originalText: effectiveText, missing: 'DATE' });
          await sock.sendMessage(groupId, { text: "Which *Dates*? (e.g. 12 Feb to 15 Feb)" }, { quoted: msg });
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
        
        // 🛡️ DEDUPLICATION FIX: Ensure we don't process same sanitized hotel twice
        let sanitizedHotels = splitHotels.map(h => sanitizedMap[h] || h);
        sanitizedHotels = [...new Set(sanitizedHotels)];

        const isAgain = rawText.toUpperCase().includes('AGAIN') || rawText.toUpperCase().includes('SAME');
        if ((splitHotels.length === 0 || (splitHotels.length === 1 && /AGAIN|SAME/i.test(splitHotels[0]))) && isAgain) {
           if (lastKnownHotels.length > 0) splitHotels = lastKnownHotels;
        } else {
           const validNow = splitHotels.map(h => normalizeHotelForAI(h)).filter(Boolean);
           if (validNow.length > 0) lastKnownHotels = validNow;
        }

        for (const hotelName of sanitizedHotels) {
          if (limitReached) break blockLoop;

          const hotel = normalizeHotelForAI(hotelName);
          if (!hotel) continue;

          const fullLine = effectiveText.split('\n').find(l => l.toLowerCase().includes(hotelName.toLowerCase())) || hotelName;
          let activeTypes = extractRoomTypesFromText(fullLine);
          if (activeTypes.length === 0) activeTypes = universalTypes;
          
          if (activeTypes.length > LIMITS.MAX_ROOM_TYPES) activeTypes = activeTypes.slice(0, LIMITS.MAX_ROOM_TYPES);

          const mealHint = extractMeal(effectiveText);
          const viewHint = extractView(effectiveText);

          // 🛡️ FIX: Combine Block Dates + Global Dates
          // This ensures the AI sees "20 Feb - 01 Mar" even if the segmenter put Kiswa in the wrong block.
// 🛡️ FIX: Combine Block Dates + Global Dates
          const allContextDates = [...new Set([...blockDateList, ...globalDateRanges])];


// 🛡️ SMART CONTEXT PROMPT
          const aiInput = protectDoubleTreeHotel([
              `TARGET_HOTEL: ${hotel}`,
              `AVAILABLE_DATES: ${allContextDates.join(', ')}`, 
              `FULL_MESSAGE_CONTEXT: ${effectiveText}`, 
              `DEFAULT_ROOMS: ${activeTypes.join(' ')}`,
              `MEAL_HINT: ${mealHint}`,
              `VIEW_HINT: ${viewHint}`,
              
              `--- LOGIC RULES ---`,
              `1. GRAVITY RULE: Dates usually appear BELOW the hotel name.`,
              `   - Exception: If a date is at the very TOP (Header), it applies to all hotels below it until a new date appears.`,
              `2. BARRIER RULE: A date line acts as a WALL.`,
              `   - "Hotel A... Date 1... Hotel B" -> Hotel B CANNOT take Date 1. It must find a date below it.`,
              `3. LAZY DATES: "15 20 mar" means "15 Mar to 20 Mar".`,
              `4. NIGHTS CALCULATION: "3 nights" starting "19 Feb" -> Check-out 22 Feb.`,
              `5. EXTRACT PAX: "6 person" -> "persons": 6.`,
              `6. STRICT VIEW: DO NOT infer views unless EXPLICITLY written.`,
              `STRICT: Return JSON only.`
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
              if (!q.view && viewHint) q.view = viewHint;
              
              // 🛡️ FIX 26-B: Room Count Sanity Cap
              // Ignore numbers > 50 (Prevents years like "2026" being treated as room count)
              // Old code: const explicitRoomCount = ...
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

              if (q.check_in && q.check_out) {
                  allQueries.push(q);
                  requestCount++;
              }

              if (q.check_in && q.check_out) {
                  allQueries.push(q);
                  requestCount++;
              }
          }
       } 
      }
      
      // ... (Rest of the standard V1 sending logic & V2 shadow mode logic remains identical)
      // I am keeping the bottom half standard as requested.
      
      if (limitReached) {
          for (const owner of getOwnerGroups()) {
              await sock.sendMessage(owner, { 
                  text: `⚠️ *SAFETY BREAKER TRIPPED*\n\n📍 Group: ${groupId}\n\n🛑 Request limit of ${LIMITS.MAX_TOTAL_REQUESTS} hit.\n✅ Auto-processed first ${LIMITS.MAX_TOTAL_REQUESTS} queries.\n⚠️ Remaining items ignored. Please check manually.` 
              });
          }
      }
      
      if (!allQueries.length) {
        for (const owner of getOwnerGroups()) {
          await sock.sendMessage(owner, { text: '⚠️ Booking rejected (no valid queries)' }, { quoted: msg });
        }
        return;
      }

// 🛡️ FINAL DEDUPLICATION (Fixes "Hilton" vs "Hilton Makkah")
// ============================================================
      // 🛡️ 4. FINAL DEDUPLICATION (The "Simple Rule")
      // ============================================================
      // Rule: SAME HOTEL & SAME DATES & SAME ROOM TYPE -> NEVER REPEAT
      
      const uniqueQueries = [];
      const seenSignatures = new Set();

      for (const q of allQueries) {
          // 1. Normalize Hotel Name for Comparison ONLY
          // This ensures "Kiswa" and "Kiswa Towers" count as the SAME hotel.
          const cleanName = (sanitizedMap[q.hotel] || q.hotel).toLowerCase()
              .replace(/\b(makkah|madinah|hotel|hotels|convention|towers|tower|jabal|omar|al|residence|suites|inn|view|guest|house)\b/gi, '')
              .replace(/[^a-z0-9]/g, '') // Remove symbols
              .trim();

          // 2. Create the Signature
          // format: "kiswa|2026-02-18|2026-02-20|quad"
          const signature = `${cleanName}|${q.check_in}|${q.check_out}|${q.room_type}`;

          // 3. Check & Push
          if (!seenSignatures.has(signature)) {
              seenSignatures.add(signature);
              uniqueQueries.push(q);
          } else {
              console.log(`🗑️ Duplicate Removed: ${q.hotel} (${q.check_in}) - Signature matched.`);
          }
      }
      
      // Update the main list to use the unique ones
      const finalQueries = uniqueQueries;

      const queriesWithRates = [];
      const queriesForVendors = [];

      for (const q of finalQueries) {
        const myRate = checkSavedRate(
            q.hotel, q.check_in, q.check_out, q.persons || 2, 
            q.room_type, q.view, q.meal
        );
        if (myRate) queriesWithRates.push({ query: q, rate: myRate });
        else queriesForVendors.push(q);
      }

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
          
          // 🛑 ERROR WAS HERE: "dateLabel" is not defined in this scope.
          // ✅ FIX: Use "query.dateLabel" only.
          const dateDisplay = formatDateRange(query.check_in, query.check_out, query.dateLabel);

          const replyText = 
`*${rate.hotel}* ${dateDisplay}
${descriptor ? `*${descriptor}* ` : ''}${typeClean}
${mealViewLine}

*${averageRate} ${rate.currency}*

*Subject to Availability*`;
          await sock.sendMessage(groupId, { text: replyText }, { quoted: msg });
      }

if (queriesForVendors.length > 0) {
          await sock.sendMessage(groupId, { text: 'checking' }, { quoted: msg });

          // 🧠 INTELLIGENT DISTRIBUTION LOGIC (1 Query Per Vendor Per Date Range)
          
          // 1. Group Queries by Date Range
          // Key: "2026-02-18|2026-02-20", Value: [Query Objects]
          const queriesByDate = {};
          for (const q of queriesForVendors) {
              const key = `${q.check_in}|${q.check_out}`;
              if (!queriesByDate[key]) queriesByDate[key] = [];
              queriesByDate[key].push(q);
          }

          // 2. Process each Date Range independently
          for (const [dateKey, queries] of Object.entries(queriesByDate)) {
              
              const usedVendorsForThisDate = new Set(); // 🔒 Locks vendors for this specific date range
              const uniqueHotels = [...new Set(queries.map(q => q.hotel))];
              
              // 3. SCARCITY SORT: Process hotels with FEWER vendors first!
              // This prevents a "popular" vendor from taking a job that only they could do elsewhere.
              const hotelOps = uniqueHotels.map(hotel => {
                  return { 
                      hotel, 
                      vendors: getVendorsForHotel(hotel) 
                  };
              }).sort((a, b) => a.vendors.length - b.vendors.length);

              // 4. Assign Vendors
              for (const op of hotelOps) {
                  const { hotel, vendors } = op;
                  
                  // Find relevant query for this hotel (to create child)
                  const relevantQuery = queries.find(q => q.hotel === hotel);
                  if (!relevantQuery) continue;

                  // Filter: Only pick vendors who haven't been used for this Date Range yet
                  const availableVendors = vendors.filter(v => !usedVendorsForThisDate.has(v));
                  
                  // Limit: Respect global limit (e.g. max 2 vendors per hotel), but primarily fresh ones
                  const selectedVendors = availableVendors.slice(0, LIMITS.MAX_VENDORS_PER_HOTEL);

                  if (selectedVendors.length > 0) {
                      console.log(`📤 Sending ${hotel} (${relevantQuery.check_in}) to:`, selectedVendors);
                      
                      const child = createChild({ parentId: parent.id, parsed: relevantQuery });
                      
                      for (const vg of selectedVendors) {
                          const sent = await sock.sendMessage(vg, { text: formatQueryForVendor(child) });
                          if (sent?.key?.id) linkVendorMessage(child.id, sent.key.id);
                          
                          // 🔒 LOCK THIS VENDOR
                          usedVendorsForThisDate.add(vg); 
                          
                          await sleep(VENDOR_SEND_DELAY_MS);
                      }
                  } else {
                      console.log(`⚠️ Skipped ${hotel} (${relevantQuery.check_in}): All capable vendors already booked for these dates.`);
                  }
              }
          }
        }
      }
    // ======================================================
    // 🧪 V2 SHADOW MODE (Vendor Reply Handler)
    // ======================================================
    if (role === 'VENDOR' && type === 'VENDOR_REPLY') {
      
      let child = null;
      const ctx = msg.message.extendedTextMessage?.contextInfo;
      if (ctx?.stanzaId) child = getChildByVendorMessage(ctx.stanzaId);
      if (!child) child = findMatchingChild(rawText, getOpenChildren());
      
      if (!child) {
          console.log("⚠️ VENDOR_REPLY: Could not match to a client query. Ignoring.");
          return;
      }

      try {
          const queryData = child.parsed || child; 
          console.log(`🧪 V2: Calculation started for ${queryData.hotel}...`);
          
          const v2Quote = await calculateQuote(queryData, rawText);
          
          if (v2Quote) {
              const report = formatForOwner(v2Quote);
              
              const owners = getOwnerGroups();
              for (const ownerGroupId of owners) {
                  await sock.sendMessage(ownerGroupId, { text: report });
              }
              console.log("✅ V2 Shadow Report sent to Owners");
              return; 

          } else {
              console.log("❌ V2: AI determined this is not a quote.");
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