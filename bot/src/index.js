const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')

const qrcode = require('qrcode-terminal')

const { segmentClientQuery } = require('./aiBlockSegmenter')
const { parseClientMessageWithAI } = require('./aiClientParser')
const { classifyMessage } = require('./messageClassifier')
const { isEmployee } = require('./employeeConfig')

const {
  getGroupRole,
  getVendorsForHotel,
  getOwnerGroups
} = require('./groupConfig')

const {
  createParent,
  getParent,
  createChild,
  getOpenChildren,
  addVendorReply,
  linkVendorMessage,
  getChildByVendorMessage
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
  // Captures: "Large Quad", "Diplomatic Suite", "Executive Triple", "Royal Room"
  const modifiers = "LARGE|SMALL|DIPLOMATIC|EXECUTIVE|ROYAL|RESIDENTIAL|PRESIDENTIAL|DELUXE|CLUB|JUNIOR|SENIOR|PANORAMA|GRAND|PREMIER|FAMILY|STUDIO|BUSINESS";
  const baseTypes = "SINGLE|DOUBLE|DBL|TWIN|TRIPLE|TRP|TPL|QUAD|QUINT|SUITE|ROOM|BED";
  
  // Regex: Finds "MODIFIER + BASE" (e.g., "LARGE QUAD")
  const complexRegex = new RegExp(`\\b(${modifiers})\\s+(${baseTypes})(?:S?)\\b`, 'gi');
  let m;
  while ((m = complexRegex.exec(t)) !== null) {
    types.push(m[0]); 
  }

  // 2. 🛡️ PAX / PERSON / GUEST MAPPING
  // Converts "3 person", "3 pax", etc. directly into standard room types
  const paxPatterns = [
    { reg: /\b(1\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE))\b/i, type: 'SINGLE' },
    { reg: /\b(2\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE))\b/i, type: 'DOUBLE' },
    { reg: /\b(3\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE))\b/i, type: 'TRIPLE' },
    { reg: /\b(4\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE))\b/i, type: 'QUAD' },
    { reg: /\b(5\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE))\b/i, type: 'QUINT' }
  ];

  paxPatterns.forEach(p => {
    if (p.reg.test(t)) types.push(p.type);
  });

  // 3. 🏠 STANDARD TYPES & SHORTHAND (Fallback)
  // Added TPL, DBL, and support for typos like "Quard"
  if (/\bSINGLE\b/i.test(t)) types.push('SINGLE');
  if (/\b(DBL|DOUBLE)\b/i.test(t)) types.push('DOUBLE');
  if (/\b(TPL|TRP|TRIPLE|TRIPPLE)\b/i.test(t)) types.push('TRIPLE');
  if (/\b(QUAD|QUARD|QAD|QUADR)\b/i.test(t)) types.push('QUAD');
  if (/\b(QUINT|QUINTU|QUINTUPLE)\b/i.test(t)) types.push('QUINT');
  if (/\b(SUITE|ROOMS?|BEDS?)\b/i.test(t)) {
     // Only add 'SUITE' if it's explicitly written
     if (t.includes('SUITE')) types.push('SUITE');
  }

  // 4. Return unique list
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
    '$1 $3 to $2 $3'
  )
}

// ======================================================
// 🔒 ROOM WORD GUARD
// ======================================================
function isRoomOnlyLine(line = '') {
  const t = line.trim().toLowerCase();
  if (!t) return true;

  // 🛡️ BLOCK GUEST NAMES & TYPICAL METADATA
  const guestLock = /\b(guest|name|nam|lead|mr|mrs|ms|pax|ref|contact|phone|booking|attention|attn)\b/i;
  if (guestLock.test(t)) return true;

  // 🛡️ ROOM TYPE TYPO FIXES (Includes your "Quard" fix)
  const roomLock = /\b(single|double|dbl|twin|triple|trp|tripple|quad|quard|qad|quadr|quint|hex|hexa|suite|room|rooms|persons|bed|beds)\b/i;
  
  // If the line is purely numbers or common separators (like "01)" or ":")
  if (/^(\d+[\s\).:-]+|[:\s-])$/.test(t)) return true;

  if (t.split(/\s+/).length > 1) {
    const words = t.split(/\s+/);
    return words.every(w => roomLock.test(w) || /^\d+$/.test(w) || guestLock.test(w) || /^[:.-]$/.test(w));
  }
  
  return roomLock.test(t);
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
  const hotelKeywords = /\b(hotel|inn|suites|tower|towers|palace|movenpick|hilton|rotana|front|manakha|nebras|view|residence|grand|plaza|voco|sheraton|accor|pullman|anwar|dar|taiba|saja|emmar|andalusia|royal|shaza|millennium|ihg|marriott|fairmont|clock|al|bakka|retaj|rawda|golden|tulip|kiswa|kiswah|khalil|safwat|madinah|convention|tree|doubletree|fundaq|bilal|elaf|kindi|bosphorus|zalal|nuzla|matheer|artal|odst|zowar)\b/i;

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

    const role = getGroupRole(groupId)
    const type = classifyMessage({ groupRole: role, text: rawText })

    const universalTypes = extractRoomTypesFromText(rawText);

    console.log('\n----------------------------')
    console.log('Group:', groupId)
    console.log('Role:', role)
    console.log('Type:', type)
    console.log('Text:', rawText)

if (role === 'CLIENT' && type === 'CLIENT_QUERY') {
      
      // 🛡️ 0. DD/MM/YYYY FORMAT CONVERTER
      let effectiveText = rawText.replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g, (match, d, m, y) => {
          const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
          const monthIndex = parseInt(m) - 1;
          return (monthIndex >= 0 && monthIndex < 12) ? `${d} ${months[monthIndex]} ${y}` : match;
      });

      effectiveText = normalizeSlashDateRange(effectiveText);
      effectiveText = normalizeMultiLineDateRange(effectiveText);
      
      // 🛡️ 1. FORGIVING DATE FORMAT FIXER
      effectiveText = effectiveText.replace(
        /(\d{1,2}(?:st|nd|rd|th)?\s*)(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/gim, 
        '$1 $2'
      );

      // 🛡️ 2. AGGRESSIVE CHECK-IN/OUT MERGER
      effectiveText = effectiveText.replace(
        /(?:check\s*[-]?\s*(?:in|inn|int|date)|arr|arrival|from)\s*[:\s-]*(\d{1,2}(?:st|nd|rd|th)?\s*[a-z]{3,9}.*?)\s*\n\s*(?:check\s*[-]?\s*(?:out|outt|date)|dep|departure|to)\s*[:\s-]*(\d{1,2}(?:st|nd|rd|th)?\s*[a-z]{3,9}.*?)(?=$|\n)/gim,
        '$1 to $2'
      );

      // 🛡️ 3. GLOBAL CLEANUP
      effectiveText = effectiveText.replace(/^(check\s*[-]?\s*(in|out|inn)|arr|dep|arrival|departure|from|to)[:\s-]*/gim, '');

      // 🛡️ 4. ORPHAN DATE MERGER
      const dateLineRegex = /^[\d\s-]{1,5}(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[\w\d\s-]*$/im;
      let lines = effectiveText.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const l1 = lines[i].trim();
        const l2 = lines[i+1].trim();
        if (dateLineRegex.test(l1) && dateLineRegex.test(l2) && !l1.toLowerCase().includes('to')) {
             lines[i] = `${l1} to ${l2}`;
             lines[i+1] = ''; 
        }
      }
      effectiveText = lines.filter(l => l !== '').join('\n');

      // 🛡️ 5. ADDRESS NOISE REMOVER
      effectiveText = effectiveText.split('\n')
        .filter(line => !/\b\d{5}\b/.test(line))
        .filter(line => !/^(makkah|madinah|saudi arabia|street|road|district)$/i.test(line.trim()))
        .join('\n');

      // Final regex cleanup
      effectiveText = effectiveText.replace(
        /(\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\s*\n\s*(\d{1,2}\s*\2)/i,
        '$1 to $3'
      );

      let segmentation
      try {
        segmentation = await segmentClientQuery(effectiveText)
      } catch (err) {
        for (const owner of getOwnerGroups()) {
          await sock.sendMessage(owner, { text: `⚠️ Segmentation failed\n${err.message}` })
        }
        return
      }

      let { blocks } = segmentation || {}
      
      if (Array.isArray(blocks)) {
        blocks = blocks.map(b => ({
            ...b,
            dates: (b.dates || '').trim(),
            hotels: Array.isArray(b.hotels) ? b.hotels.map(h => h.trim()).filter(Boolean) : []
          })).filter(b => b.dates || b.hotels.length)
      }

      // Fill in hotel names if missing
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (!Array.isArray(block.hotels) || block.hotels.length === 0) {
            block.hotels = effectiveText.split('\n')
              .map(l => l.trim())
              .filter(Boolean)
              .filter(l => !isRoomOnlyLine(l))
          }
        }
      }

      if (!Array.isArray(blocks) || blocks.length === 0) {
        for (const owner of getOwnerGroups()) {
          await sock.sendMessage(owner, { text: '⚠️ No valid booking blocks detected' })
        }
        return
      }

      const parent = createParent({ clientGroupId: groupId, originalMessage: msg })
      const allQueries = []
      
      const globalDateRanges = [];
      const dateRegex = /(\d{1,2})[\s-]*(?:to|[-/]|and)[\s-]*(\d{1,2})[\s-]*([a-z]{3,9})/gi;
      let dateMatch;
      while ((dateMatch = dateRegex.exec(effectiveText)) !== null) {
          globalDateRanges.push(`${dateMatch[1]} ${dateMatch[3]} to ${dateMatch[2]} ${dateMatch[3]}`);
      }

      // --- START OF COMPLETE BLOCK LOOP ---
      let lastKnownHotels = []; 

      for (const block of blocks) {
        let blockDateList = [];
        if (block.dates) {
          const rawLines = block.dates.split('\n').map(l => l.trim()).filter(Boolean);
          const cleanLines = rawLines.map(l => l.replace(/^(check\s*[-]?\s*(in|out|inn|date)|arr|dep|arrival|departure|from|to)[:\s-]*/i, '').trim());
          const mergedDates = [];
          for (let i = 0; i < cleanLines.length; i++) {
            const current = cleanLines[i];
            const next = cleanLines[i+1];
            if (next && isPureDateLine(current) && isPureDateLine(next) && !current.toLowerCase().includes('to')) {
              mergedDates.push(`${current} to ${next}`);
              i++; 
            } else if (isPureDateLine(current) || current.includes('to') || current.includes('-')) {
              mergedDates.push(current);
            }
          }
          blockDateList = mergedDates;
        }
        if (blockDateList.length === 0 && globalDateRanges.length > 0) blockDateList = globalDateRanges;

        let rawHotelList = block.hotels || [];
        let splitHotels = [];
        for (const rh of rawHotelList) {
          const parts = rh.split(/\s*\/\s*|\s+or\s+|\s*&\s*|,\s*|\n/i).map(h => h.trim()).filter(Boolean);
          splitHotels.push(...parts);
        }

        const isAgain = rawText.toUpperCase().includes('AGAIN') || rawText.toUpperCase().includes('SAME');
        if ((splitHotels.length === 0 || (splitHotels.length === 1 && /AGAIN|SAME/i.test(splitHotels[0]))) && isAgain) {
           if (lastKnownHotels.length > 0) splitHotels = lastKnownHotels;
        } else {
           const validNow = splitHotels.map(h => normalizeHotelForAI(h)).filter(Boolean);
           if (validNow.length > 0) lastKnownHotels = validNow;
        }

        for (const hotelName of splitHotels) {
          const hotel = normalizeHotelForAI(hotelName);
          if (!hotel) continue;

          const fullLine = effectiveText.split('\n').find(l => l.toLowerCase().includes(hotelName.toLowerCase())) || hotelName;
          const lineTypes = extractRoomTypesFromText(fullLine);
          const activeTypes = lineTypes.length > 0 ? lineTypes : universalTypes;
          const mealHint = extractMeal(effectiveText);
          const viewHint = extractView(effectiveText);

          for (const dateRange of blockDateList) {
            const aiInput = protectDoubleTreeHotel([
              `DATES: ${dateRange}`, `HOTEL: ${hotel}`, `CONTEXT: ${effectiveText}`, 
              `ROOMS: ${activeTypes.join(' ')}`, `MEAL_HINT: ${mealHint}`, `VIEW_HINT: ${viewHint}`,
              `STRICT: Extract check_in and check_out for ${dateRange} ONLY.`
            ].join('\n'));

            let ai;
            try { ai = await parseClientMessageWithAI(aiInput); } catch (err) { continue; }
            if (!ai?.queries) continue;

            for (const qRaw of ai.queries) {
              const q = { ...qRaw };
              
              // 🩹 NAN REPAIR
              if (q.check_out && q.check_out.includes('NaN')) {
                 const dLow = dateRange.toLowerCase();
                 if (dLow.includes('apri')) q.check_out = q.check_out.replace(/-NaN-/, '-04-');
                 if (dLow.includes('marc')) q.check_out = q.check_out.replace(/-NaN-/, '-03-');
              }

              if (!normalizeHotelForAI(q.hotel)) q.hotel = hotel;

              const cIn = new Date(q.check_in);
              const cOut = new Date(q.check_out);
              if (isNaN(cIn.getTime()) || isNaN(cOut.getTime())) continue;

              // Force Merged Dates Logic
              if (dateRange.includes('to') && q.check_in === q.check_out) continue;
              if (!dateRange.includes('to') && q.check_in === q.check_out && !/\b(1|one)\s*night\b/i.test(effectiveText)) continue;

              if (q.confidence === 0) continue;
              
              if (!q.meal && mealHint) q.meal = mealHint;
              if (!q.view && viewHint) q.view = viewHint;

              // 👑 NEW: STRICT ROOM TYPE LOGIC
              if (activeTypes.length > 0) {
                 let match = activeTypes.find(t => q.room_type.toUpperCase().includes(t) || t.includes(q.room_type.toUpperCase()));
                 if (!match) match = activeTypes[0];
                 const aiAddedExtra = q.room_type.toUpperCase().includes('EXTRA');
                 const userSaidExtra = effectiveText.toUpperCase().includes('EXTRA') || effectiveText.toUpperCase().includes('SHARING');
                 
                 if (aiAddedExtra && !userSaidExtra) q.room_type = match; 
                 else q.room_type = match;
              } else {
                 if (!q.room_type || !q.room_type.trim() || q.room_type.toUpperCase() === 'ROOM') q.room_type = 'DOUBLE + EXTRA BED';
              }
              // ============================================================

              if (typeof q.persons === 'number' && q.persons >= 5) {
                 const paxString = `${q.persons} PAX`;
                 if (!q.room_type.toUpperCase().includes(paxString)) {
                    q.room_type = `${q.room_type} ${paxString}`;
                 }
              }
              
              if (!q.rooms || q.rooms < 1) q.rooms = 1;

              if (q.check_in && q.check_out) {
                allQueries.push(q);
              }
            }
          } 
        } 
      } 
      // --- END OF COMPLETE BLOCK LOOP ---

      if (!allQueries.length) {
        for (const owner of getOwnerGroups()) {
          await sock.sendMessage(owner, { text: '⚠️ Booking rejected (no valid queries after normalization)' }, { quoted: msg })
        }
        return
      }

      // 1. Deduplication
      const seen = new Set()
      const finalQueries = allQueries.filter(q => {
        const k = `${q.hotel}|${q.check_in}|${q.check_out}|${q.rooms}|${q.room_type}|${q.view}|${q.meal}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })

      // 2. Split: Saved Rates vs. Vendors
      const queriesWithRates = [];
      const queriesForVendors = [];

      for (const q of finalQueries) {
        // To THIS:
        const myRate = checkSavedRate(
            q.hotel, 
            q.check_in, 
            q.check_out, 
            q.persons || 2, 
            q.room_type, 
            q.view, // Pass the view
            q.meal  // Pass the meal
        );
          if (myRate) {
              queriesWithRates.push({ query: q, rate: myRate });
          } else {
              queriesForVendors.push(q);
          }
      }

// 3. HANDLE SAVED RATES (Instant Reply)
      for (const item of queriesWithRates) {
          const { query, rate } = item;

          // 🧠 DESCRIPTOR SPLITTING
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

          // 🧮 CALCULATION: Get Average Rate
          const totalAmount = rate.breakdown.reduce((sum, b) => sum + b.price, 0);
          const nightCount = rate.breakdown.length;
          const averageRate = Math.round(totalAmount / nightCount); // Round to nearest SAR

          // 📝 THE CLEAN FORMAT
          const mealViewLine = `${rate.applied_meal}${rate.applied_view ? ` / ${rate.applied_view}` : ''}`;

          const replyText = 
`*${rate.hotel}*
${descriptor ? `*${descriptor}* ` : ''}${typeClean}
${mealViewLine}

*${averageRate} ${rate.currency}*

*Subject to Availability*`;
          
          await sock.sendMessage(groupId, { text: replyText }, { quoted: msg });
      }

      // 4. Vendor Broadcast (If needed)
      if (queriesForVendors.length > 0) {
          await sock.sendMessage(groupId, { text: 'checking' }, { quoted: msg });
          for (const q of queriesForVendors) {
              const child = createChild({ parentId: parent.id, parsed: q });
              const vendors = getVendorsForHotel(q.hotel);
              console.log('📤 Sending to vendors:', q.hotel, '→', vendors);
              for (const vg of vendors) {
                  const sent = await sock.sendMessage(vg, { text: formatQueryForVendor(child) });
                  if (sent?.key?.id) linkVendorMessage(child.id, sent.key.id);
                  await sleep(VENDOR_SEND_DELAY_MS);
              }
          }
      }
    }
    if (role === 'VENDOR' && type === 'VENDOR_REPLY') {
      if (PRODUCTION_MVP_MODE) return

      let child = null
      const ctx = msg.message.extendedTextMessage?.contextInfo
      if (ctx?.stanzaId) child = getChildByVendorMessage(ctx.stanzaId)
      if (!child) child = findMatchingChild(rawText, getOpenChildren())
      if (!child) return

      let rateResult
      try {
        rateResult = isSimpleRate(rawText)
          ? calculateSimpleRate({ child, vendorText: rawText })
          : await calculateComplexRate({ child, vendorText: rawText })
      } catch {
        return
      }

      addVendorReply(child.id, { breakdown: rateResult, rawText })

      if (!child.firstReplyAt) {
        child.firstReplyAt = Date.now()
        setTimeout(async () => {
          if (!child.hasSentInitialRate) {
            const lastReply = child.vendorReplies.slice(-1)[0]
            await sock.sendMessage(
              getParent(child.parentId).clientGroupId,
              { text: lastReply.replyText },
              { quoted: getParent(child.parentId).originalMessage }
            )
            child.hasSentInitialRate = true
          }
        }, RESPONSE_DELAY_MS)
      }
    }
  })
}

startBot()