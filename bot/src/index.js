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
  MAX_TOTAL_REQUESTS: 5, // Hard cap: No more than 15 vendor msgs per user msg
  MAX_DATE_RANGES: 2,     // Max distinct date ranges (e.g. 1-5 Feb, 10-12 Feb...)
  MAX_HOTELS: 3,          // Max distinct hotels per query
  MAX_ROOM_TYPES: 2,       // Max distinct room types per hotel
  MAX_VENDORS_PER_HOTEL: 2 // 🛡️ NEW: How many vendors get the blast?
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
  // Added (?:S?) to handle "SINGLES", "DOUBLES", "TRIPLES", "QUADS"
  if (/\bSINGLE(?:S?)\b/i.test(t)) types.push('SINGLE');
  if (/\b(DBL|DOUBLE|DUBLE|TWIN)(?:S?)\b/i.test(t)) types.push('DOUBLE');
  if (/\b(TPL|TRP|TRIPLE|TRIPPLE|TRIPAL)(?:S?)\b/i.test(t)) types.push('TRIPLE'); 
  if (/\b(QUAD|QUARD|QAD|QUADR|QD)(?:S?)\b/i.test(t)) types.push('QUAD'); 
  if (/\b(QUINT|QUINTU|QUINTUPLE)(?:S?)\b/i.test(t)) types.push('QUINT');
  
  if (/\b(SUITE|ROOM|BED)(?:S?)\b/i.test(t)) {
     if (t.includes('SUITE')) types.push('SUITE');
  }

  return [...new Set(types)];
}
function normalizeMultiLineDateRange(text = '') {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  if (lines.length >= 2) {
    const d1 = lines[0].match(/^(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i)
    const d2 = lines[1].match(/^(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i)

    if (d1 && d2 && d1[2].toLowerCase() === d2[2].toLowerCase()) {
      return [
        `${d1[1]} ${d1[2]} to ${d2[1]} ${d2[2]}`,
        ...lines.slice(2)
      ].join('\n')
    }
  }
  return text
}


function extractMeal(text = '') {
  const t = text.toUpperCase();
  
  // 🌙 RAMADAN MEALS (Sehri / Iftar)
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
function formatDateRange(checkIn, checkOut) {
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
// 🔒 ROOM WORD GUARD
// ======================================================
function isRoomOnlyLine(line = '') {
  const t = line.trim().toLowerCase();
  if (!t) return true;

  // 1. DATES (Reject lines like "5 to 10 mar", "12 feb")
  if (/(\d{1,2})[\s-]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true;
  if (/check\s*(in|out)|arr|dep|from|to/i.test(t)) return true;

  // 2. GUEST NAMES / METADATA
  const guestLock = /\b(guest|name|nam|lead|mr|mrs|ms|pax|ref|contact|phone|booking|attention|attn)\b/i;
  if (guestLock.test(t)) return true;

  // 3. ROOMS / MEALS / VIEWS (The "Not a Hotel" Dictionary)
  // Added: ro, bb, hb, fb, view, city, haram, kaaba
  const roomLock = /\b(single|double|dbl|twin|triple|trp|tripple|quad|quard|quart|qad|qud|quadr|quint|hex|hexa|suite|room|rooms|persons|bed|beds|view|veiw|vew|city|haram|kaaba|ro|bb|hb|fb|breakfast)\b/i;
  
  // Single word check (e.g. just "Quad")
  if (t.split(/\s+/).length === 1 && roomLock.test(t)) return true;

  // Multi-word check: If EVERY word is a keyword or number, it's not a hotel
  // e.g. "2 dbl ro" -> 2(num), dbl(room), ro(meal) -> TRUE (Blocked)
  const words = t.split(/\s+/);
  const isAllKeywords = words.every(w => 
      roomLock.test(w) || 
      /^\d+$/.test(w) || 
      guestLock.test(w) || 
      /^[:.-]+$/.test(w) ||
      w.length < 2 // Ignore single letters like "&"
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

  // 🛡️ NEW: Address & Zip Code Guard
  // Rejects lines like "Makkah 21955" or "Ibrahim Al Khalil"
  if (/\b\d{5}\b/.test(h)) return null; // Blocks 5-digit zip codes
  if (/^(makkah|madinah|saudi arabia|street|road|district|jabal omar ibrahim al khalil)$/i.test(h)) return null;

  // 🛡️ 1. HARD BLOCK: Hallucinations (Dates/Filler)
  // Added 'nights' and 'date' to prevent "Nights: 6" or "Check-in Date" issues
  const badPatterns = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|again|check|plz|please|pax|room|triple|quad|double|booking|nights|date)\b/i;
  if (badPatterns.test(h)) return null;

  // 🛡️ 2. DATE & NUMBER BLOCKER
  if (/^\d{1,2}[\/\-]\d{1,2}/.test(h)) return null;
  if (/^[\d\s\-\/\.]+$/.test(h)) return null;
  if (h.length < 3) return null;
  if (/^hotel$/i.test(h)) return null;

  // 🛡️ 3. BRAND PROTECTION
  h = h.replace(/\b(double|dbl)\s*tree\b/gi, 'DoubleTree');
  h = h.replace(/\b(fundaq|fudnaq)\b/gi, 'Fundaq');

  // 🛡️ 4. HOTEL KEYWORD LIST
  const hotelKeywords = /\b(hotel|inn|suites|lamar|emaar|jabal|tower|towers|palace|movenpick|hilton|rotana|front|manakha|nebras|view|residence|grand|plaza|voco|sheraton|accor|pullman|anwar|dar|taiba|saja|emmar|andalusia|royal|shaza|millennium|ihg|marriott|fairmont|clock|al|bakka|retaj|rawda|golden|tulip|kiswa|kiswah|khalil|safwat|madinah|convention|tree|doubletree|fundaq|bilal|elaf|kindi|bosphorus|zalal|nuzla|matheer|artal|odst|zowar)\b/i;

  // 🛡️ NOISE CLEANER
  h = h.replace(/\b(single|double|dbl|twin|triple|trp|tripple|quad|quard|room|only|bed|breakfast|bb|ro)\b/gi, '').trim();

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

    // ======================================================
    // 🧠 REPLY MERGER (Conversational Repair)
    // ======================================================
    const { getPendingQuestion, clearPendingQuestion } = require('./queryStore');
    const pending = getPendingQuestion(groupId);
    let finalProcessingText = rawText;

    if (pending) {
        // If the current message is a short answer (like "dbl" or "12-14 feb")
        // combine it with the original text we saved earlier.
        console.log(`🔗 Merger: Found pending ${pending.missing}. Combining...`);
        finalProcessingText = `${pending.originalText}\n${rawText}`;
        clearPendingQuestion(groupId); // Clear so we don't loop
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
      // 🛡️ 1. ROBUST PRE-PROCESSING (The "Omni-Reaper")
      // ============================================================
      let preProcessedText = finalProcessingText
        // A. Fix "DD/DD Month" ranges FIRST (e.g. "01/05 march" -> "01 to 05 march")
        .replace(/(\d{1,2})\s*[\/-]\s*(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi, '$1 to $2 $3')
        
        // B. Fix "DD/MM" numeric dates (e.g. "12/2" -> "12 Feb")
        .replace(/\b(\d{1,2})[\/-](\d{1,2})\b/g, (match, d, m) => {
            if (parseInt(m) > 12) return `${d} to ${m}`; 
            const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            return `${d} ${months[parseInt(m)-1]}`;
        })
        
        // C. Standardize "DD/MM/YYYY"
        .replace(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/g, (m, d, mth, y) => {
             const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
             return `${d} ${months[parseInt(mth)-1]} ${y}`;
        })
        
        // D. Fix Month Order ("Feb 16" -> "16 Feb")
        .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*(\d{1,2})\b/gi, '$2 $1');

      let lines = preProcessedText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      let pairedLines = [];
      let dateBuffer = null;

      for (let i = 0; i < lines.length; i++) {
          let line = lines[i];

          // 🛑 GUARD 1: If line ALREADY has "12 to 15", don't split it!
          if (/\d+\s*to\s*\d+/i.test(line)) {
              if (dateBuffer) { pairedLines.push(dateBuffer); dateBuffer = null; }
              pairedLines.push(line);
              continue;
          }

          // 🛑 GUARD 2: Ignore "Room Count" lines (Fixes the "2 quards" bug)
          // If line starts with number but is followed by "rooms", "pax", "quad", "dbl", it is NOT a date.
          if (/^\d+\s*(room|pax|guest|adult|child|quad|quint|trp|trip|dbl|doub|sgl|sing|bed)/i.test(line)) {
              if (dateBuffer) { pairedLines.push(dateBuffer); dateBuffer = null; }
              pairedLines.push(line);
              continue;
          }

          // Keyword Detection
          let isDateLine = /^(?:check\s*in|chk\s*in|arr|from|arriving|check\s*out|chk\s*out|dep|to|in|out|leaving)[:\s-]*(\d.*)/i.exec(line);
          
          // If no keyword, check if it looks like a pure date "5 mar"
          if (!isDateLine) {
              const pureDate = /^(\d{1,2}(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i.exec(line);
              if (pureDate) isDateLine = [line, pureDate[1]]; // Fake the regex match structure
          }
          
          if (isDateLine) {
              let extractedDate = isDateLine[1] || isDateLine[2]; // Handle both regex groups
              extractedDate = extractedDate.trim();

              if (!dateBuffer) {
                  dateBuffer = extractedDate; 
              } else {
                  // Pair found!
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
      const dateOnlyRegex = /^(\d{1,2}(?:st|nd|rd|th)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;

      for (let i = 0; i < pairedLines.length; i++) {
        let current = pairedLines[i];
        let next = (pairedLines[i+1] || "").trim();
        if (dateOnlyRegex.test(current) && dateOnlyRegex.test(next) && !current.toLowerCase().includes('to')) {
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
        .filter(line => !/\b\d{5}\b/.test(line)) 
        .filter(line => {
            const isLong = line.split(' ').length > 15;
            const hasKey = /check|arr|dep|night|room|bed|guest|leaving|arriving|please|rate/i.test(line);
            return !isLong || hasKey; 
        }) 
        .filter(line => !/saudi arabia|street|road|district|jabal omar/i.test(line))
        .join('\n')
        .replace(/^(check\s*in|check\s*out|chk|arr|dep|from|to|in|out|arriving|leaving)[:\s-]*/gim, '');

      console.log("💎 Final Processed Text for AI:\n", effectiveText);

      // ============================================================
      // 🛡️ 2. SEGMENTATION & BLOCK FUSING
      // ============================================================
      let segmentation;
      try {
        segmentation = await segmentClientQuery(effectiveText);
      } catch (err) {
        for (const owner of getOwnerGroups()) {
          await sock.sendMessage(owner, { text: `⚠️ Segmentation failed\n${err.message}` });
        }
        return;
      }

// [Previous Segmentation Code ...]

      let { blocks: rawBlocks } = segmentation || {};
      let blocks = [];
      
      // BLOCK FUSER
      if (Array.isArray(rawBlocks)) {
        rawBlocks.forEach(b => {
          let last = blocks[blocks.length - 1];
          const isSameHotel = last && JSON.stringify(last.hotels) === JSON.stringify(b.hotels);
          if (isSameHotel) {
            last.dates = (last.dates + '\n' + b.dates).trim();
          } else {
            blocks.push({
              ...b,
              dates: (b.dates || '').trim(),
              hotels: Array.isArray(b.hotels) ? b.hotels.map(h => h.trim()).filter(Boolean) : []
            });
          }
        });
      }

      // 🛡️ CRITICAL FIX: Aggressively filter hotels list
      // This removes "Quard", "5-10 Mar", "Dbl RO" from the hotel array
      for (const block of blocks) {
        if (Array.isArray(block.hotels)) {
            block.hotels = block.hotels.filter(h => !isRoomOnlyLine(h));
        }
      }

      // Fallback: If no hotels found, guess from text (but use the STRICT filter)
      for (const block of blocks) {
        if (!Array.isArray(block.hotels) || block.hotels.length === 0) {
          block.hotels = effectiveText.split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .filter(l => !isRoomOnlyLine(l)); // <--- Now uses the new stricter logic
        }
      }

      // [Proceed to Global Date Ranges...]
      if (blocks.length === 0) {
        for (const owner of getOwnerGroups()) {
          await sock.sendMessage(owner, { text: '⚠️ No valid booking blocks detected' });
        }
        return;
      }

      const parent = createParent({ clientGroupId: groupId, originalMessage: msg });
      const allQueries = [];
      
      // Global Data Collection
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
          globalHotels.forEach((raw, i) => { sanitizedMap[raw] = cleaned[i] || raw; });
      }
      
      let lastKnownHotels = []; 

      // 🕵️ Conversational Repair
// 🕵️ CONVERSATIONAL REPAIR
      const hasDate = /(\d{1,2})\s*(?:to|-)?\s*(\d{1,2})?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(effectiveText);
      
      // 🛡️ FIX: Added 'quard', 'tripple', 'qad', 'prsn' to the whitelist
      const hasRoom = /\b(sgl|single|dbl|double|tw|twin|trp|triple|tripple|quad|quard|qad|quint|pax|bed|room|guest|person|prsn|ppl)s?\b/i.test(effectiveText);
      
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
      // 🛡️ 3. MAIN PROCESSING LOOP (WITH SAFETY BREAKER)
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
          // Re-clean dates
          const rawLines = block.dates.split('\n').map(l => l.trim()).filter(Boolean);
          const cleanLines = rawLines.map(l => l.replace(/^(check\s*[-]?\s*(in|out|inn|date)|arr|dep|arrival|departure|from|to)[:\s-]*/i, '').trim());
          
          const mergedDates = [];
          for (let i = 0; i < rawLines.length; i++) {
            const currentClean = cleanLines[i];
            const nextClean = cleanLines[i+1];
            
            // Basic merging logic for already blocked dates
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
        
        const sanitizedHotels = splitHotels.map(h => sanitizedMap[h] || h);

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

          // 👑 ROOM TYPE LOGIC
          const fullLine = effectiveText.split('\n').find(l => l.toLowerCase().includes(hotelName.toLowerCase())) || hotelName;
          let activeTypes = extractRoomTypesFromText(fullLine);
          if (activeTypes.length === 0) activeTypes = universalTypes;
          
          if (activeTypes.length > LIMITS.MAX_ROOM_TYPES) activeTypes = activeTypes.slice(0, LIMITS.MAX_ROOM_TYPES);

          const mealHint = extractMeal(effectiveText);
          const viewHint = extractView(effectiveText);

          const aiInput = protectDoubleTreeHotel([
              `HOTEL: ${hotel}`,
              `DATES_DATA: ${blockDateList.join('\n')}`, 
              `CONTEXT: ${effectiveText}`, 
              `ROOMS: ${activeTypes.join(' ')}`,
              `MEAL_HINT: ${mealHint}`,
              `VIEW_HINT: ${viewHint}`,
              `STRICT: Extract all stays. "2 dbl" means rooms: 2. "2 rooms 8 pax" means rooms: 2.`
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

              // NaN Repair
              if (q.check_out && q.check_out.includes('NaN')) {
                 const low = effectiveText.toLowerCase();
                 if (low.includes('apri')) q.check_out = q.check_out.replace(/-NaN-/, '-04-');
                 if (low.includes('marc')) q.check_out = q.check_out.replace(/-NaN-/, '-03-');
                 if (low.includes('feb')) q.check_out = q.check_out.replace(/-NaN-/, '-02-');
              }
              
              const cIn = new Date(q.check_in);
              const cOut = new Date(q.check_out);
              if (isNaN(cIn.getTime()) || isNaN(cOut.getTime())) continue;

              if (q.check_in === q.check_out && !rawText.toLowerCase().includes('1 night')) continue;
              if (q.confidence === 0) continue;
              
              if (!q.meal && mealHint) q.meal = mealHint;
              if (!q.view && viewHint) q.view = viewHint;
              
              const explicitRoomCount = (effectiveText.match(/(\d+)\s*(?:room|dbl|double|quad|trip|trp)/i) || [])[1];
              if (explicitRoomCount && q.rooms === 1) q.rooms = parseInt(explicitRoomCount);

              if (activeTypes.length > 0) {
                  let match = activeTypes.find(t => q.room_type.toUpperCase().includes(t) || t.includes(q.room_type.toUpperCase()));
                  if (!match) match = activeTypes[0];
                  
                  const aiAddedExtra = q.room_type.toUpperCase().includes('EXTRA');
                  const userSaidExtra = effectiveText.toUpperCase().includes('EXTRA') || effectiveText.toUpperCase().includes('SHARING');
                  if (aiAddedExtra && !userSaidExtra) q.room_type = match; 
                  else q.room_type = match;
              }

              // 👑 ROOM TYPE FORMATTER 👑
              // Logic: Only show "(X Pax)" if it is a Suite or large unit. 
              // "2 Quad" remains "2 Quad". "1 Suite" becomes "1 Suite (6 Pax)".
              if (typeof q.persons === 'number' && q.persons >= 1) {
                  const isVariableCapacity = /SUITE|STUDIO|APARTMENT|VILLA|CHALET|FAMILY/i.test(q.room_type);
                  
                  if (isVariableCapacity) {
                      const paxLabel = `(${q.persons} Pax)`;
                      // Prevent duplicate labels if AI already added it
                      if (!q.room_type.toUpperCase().includes('PAX')) {
                          q.room_type = `${q.room_type} ${paxLabel}`;
                      }
                  }
              }
              
              if (!q.rooms || q.rooms < 1) q.rooms = 1;

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
      
      if (!allQueries.length) {
        for (const owner of getOwnerGroups()) {
          await sock.sendMessage(owner, { text: '⚠️ Booking rejected (no valid queries)' }, { quoted: msg });
        }
        return;
      }

      const seen = new Set();
      const finalQueries = allQueries.filter(q => {
        const k = `${q.hotel}|${q.check_in}|${q.check_out}|${q.rooms}|${q.room_type}|${q.view}|${q.meal}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

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
          const dateDisplay = formatDateRange(query.check_in, query.check_out);

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

          // 🧠 INTELLIGENT VENDOR LOCKING 🧠
          // We decide WHICH vendors get the job BEFORE we loop through the dates.
          // This ensures Vendor A gets ALL dates, instead of Date 1 going to A and Date 2 to B.
          
          const uniqueHotels = [...new Set(queriesForVendors.map(q => q.hotel))];
          const vendorSessionMap = {}; // Stores { "Voco": [VendorA, VendorB] }

          for (const hotel of uniqueHotels) {
              let allVendors = getVendorsForHotel(hotel);
              
              // 🛡️ Apply Vendor Limit
              // If we have 5 vendors but limit is 2, we only pick the first 2.
              // (Future upgrade: Rotate these or pick random to be fair)
              if (allVendors.length > LIMITS.MAX_VENDORS_PER_HOTEL) {
                  allVendors = allVendors.slice(0, LIMITS.MAX_VENDORS_PER_HOTEL);
              }
              
              vendorSessionMap[hotel] = allVendors;
          }

          // 🚀 EXECUTION LOOP
          for (const q of queriesForVendors) {
              const child = createChild({ parentId: parent.id, parsed: q });
              
              // Retrieve the LOCKED vendors for this hotel
              const targetVendors = vendorSessionMap[q.hotel] || [];

              if (targetVendors.length > 0) {
                  console.log(`📤 Sending ${q.hotel} (${q.check_in}) to LOCKED set:`, targetVendors);
                  
                  for (const vg of targetVendors) {
                      const sent = await sock.sendMessage(vg, { text: formatQueryForVendor(child) });
                      if (sent?.key?.id) linkVendorMessage(child.id, sent.key.id);
                      await sleep(VENDOR_SEND_DELAY_MS);
                  }
              } else {
                  console.log(`⚠️ No vendors found for ${q.hotel}`);
              }
          }
      }
  }    
if (role === 'VENDOR' && type === 'VENDOR_REPLY') {
      
      // 1. Context Matching (Find who this reply belongs to)
      let child = null;
      const ctx = msg.message.extendedTextMessage?.contextInfo;
      if (ctx?.stanzaId) child = getChildByVendorMessage(ctx.stanzaId);
      if (!child) child = findMatchingChild(rawText, getOpenChildren());
      
      if (!child) {
          console.log("⚠️ VENDOR_REPLY: Could not match to a client query. Ignoring.");
          return;
      }

      // ====================================================
      // 🧪 V2 SHADOW MODE (Active Testing)
      // ====================================================
      try {
          console.log(`🧪 V2: Calculation started for ${child.hotel}...`);
          
// 🛡️ DATA UNPACKING: Handle structure { id: '...', parsed: { hotel: '...' } }
      const queryData = child.parsed || child; 

      console.log(`🧪 V2: Calculation started for ${queryData.hotel}...`);
      
      // Step A: Run the AI Parser & Calculator
      const v2Quote = await calculateQuote(queryData, rawText);
          
          if (v2Quote) {
              // Step B: Format the "Secret Report"
              const report = formatForOwner(v2Quote);
              
              // Step C: Send to ALL Owner Groups
              const owners = getOwnerGroups();
              for (const ownerGroupId of owners) {
                  await sock.sendMessage(ownerGroupId, { text: report });
              }
              console.log("✅ V2 Shadow Report sent to Owners");
              
              // 🛑 STOP HERE: Do not send anything to the client yet.
              // We want to verify the math in the owner group first.
              return; 

          } else {
              console.log("❌ V2: AI determined this is not a quote (chit-chat or unclear).");
          }
      } catch (err) {
          console.error("⚠️ V2 Critical Error:", err);
          // If V2 crashes, we log it and do nothing (Safe Fail)
      }
      
      return; // Ensure no V1 logic runs accidentally during this test phase
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