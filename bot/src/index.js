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
  const baseTypes = "SINGLE|DOUBLE|DBL|TWIN|TRIPLE|TRP|QUAD|QUINT|SUITE|ROOM|BED";
  
  // Regex: Finds "MODIFIER + BASE" (e.g., "LARGE QUAD")
  const complexRegex = new RegExp(`\\b(${modifiers})\\s+(${baseTypes})(?:S?)\\b`, 'gi');
  let m;
  while ((m = complexRegex.exec(t)) !== null) {
    types.push(m[0]); // Pushes "LARGE QUAD"
  }

  // 2. 🛡️ PAX / PERSON / GUEST MAPPING
  // This converts "3 person", "3 pax", "3 guests" directly into room types
  
  // Single (1)
  if (/\b(1\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE))\b/i.test(t)) {
    types.push('SINGLE');
  }

  // Double (2)
  if (/\b(2\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE))\b/i.test(t)) {
    types.push('DOUBLE');
  }

  // Triple (3)
  if (/\b(3\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE))\b/i.test(t)) {
    types.push('TRIPLE');
  }

  // Quad (4)
  if (/\b(4\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE))\b/i.test(t)) {
    types.push('QUAD');
  }

  // Quint (5)
  if (/\b(5\s*(PAX|PERSON|PERSONS|GUEST|GUESTS|PEOPLE))\b/i.test(t)) {
    types.push('QUINT');
  }

  // 3. 🏠 STANDARD TYPES (Fallback)
  // We check these last so we don't accidentally duplicate if "Large Quad" was already found.
  // However, we allow duplicates here because the main loop filters them out using `Set` later.
  
  if (/\bSINGLE\b/i.test(t)) types.push('SINGLE');
  if (/\b(DBL|DOUBLE)\b/i.test(t)) types.push('DOUBLE');
  if (/\b(TRP|TRIPLE|TRIPPLE)\b/i.test(t)) types.push('TRIPLE');
  if (/\b(QUAD|QUARD|QAD|QUADR)\b/i.test(t)) types.push('QUAD');
  if (/\b(QUINT|QUINTU|QUINTUPLE)\b/i.test(t)) types.push('QUINT');

  // 4. Return unique list
  // Uses Set to remove duplicates (e.g. if it found "Large Quad" and "Quad", keep both or just specific?)
  // We return ALL matches so the main loop can pick the most specific one.
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
  // 🛡️ Remove "Check in", "Check out", "Arr", "Dep" before checking
  const t = text.trim().toLowerCase()
    .replace(/^(check\s*(in|out|inn)|arr|dep|arrival|departure|from|to)[:\s-]*/i, '')
    .trim();

  if (!t) return false;

  // Matches "05 march", "5 mar", "20-feb"
  const datePattern = /^\d{1,2}[\s-]* (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i;
  return datePattern.test(t);
}

// ======================================================
// 🔒 HOTEL NORMALIZATION
// ======================================================
function normalizeHotelForAI(hotel = '') {
  let h = hotel.trim();
  if (!h || h.toLowerCase() === 'similar') return null;

  // 1. 🛡️ DATE & NUMBER BLOCKER
  if (/^\d{1,2}[\/\-]\d{1,2}/.test(h)) return null;
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(h)) return null;
  if (/^[\d\s\-\/\.]+$/.test(h)) return null;
  if (h.length < 3) return null;
  if (/^hotel$/i.test(h)) return null;

  // 2. 🛡️ BRAND PROTECTION (Fixes "Double Tree" -> "Tree")
  // Merge "Double Tree" so the word "Double" isn't stripped later
  h = h.replace(/\b(double|dbl)\s*tree\b/gi, 'DoubleTree');
  h = h.replace(/\b(fundaq|fudnaq)\b/gi, 'Fundaq'); // Fix common spelling

  // 3. 🛡️ GUEST NAME BLOCKER
  const guestIndicators = /\b(mr|mrs|ms|guest|name|lead|contact|pax|attn|attention|ali|ahmed|muhammad|hussain|khan|paras|kayani)\b/i;
  
  // 4. 🛡️ HOTEL KEYWORD LIST
  const hotelKeywords = /\b(hotel|inn|suites|tower|towers|palace|movenpick|hilton|rotana|front|manakha|nebras|view|residence|grand|plaza|voco|sheraton|accor|pullman|anwar|dar|taiba|saja|emmar|andalusia|royal|shaza|millennium|ihg|marriott|fairmont|clock|al|bakka|retaj|rawda|golden|tulip|kiswa|kiswah|khalil|safwat|madinah|convention|tree|doubletree|fundaq|bilal|elaf|kindi|bosphorus)\b/i;

  // 🛡️ NOISE CLEANER (Strips "Double", "Quad", etc.)
  h = h.replace(/\b(single|double|dbl|twin|triple|trp|tripple|quad|quard|room|only|bed|breakfast|bb|ro)\b/gi, '').trim();

  const words = h.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  // 1-WORD CHECK
  if (words.length === 1) {
    const isBrand = hotelKeywords.test(h);
    const isCode = /^[A-Z]{3,10}$/.test(h);
    if (!isBrand && !isCode) return null; 
  }

  // 2+ WORD CHECK
  if (words.length >= 2) {
    if (guestIndicators.test(h) && !hotelKeywords.test(h)) return null;
  }

  // CASE FORMATTING
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
      let effectiveText = normalizeSlashDateRange(rawText);
      effectiveText = normalizeMultiLineDateRange(effectiveText);
      
      // 🛡️ 1. DATE FORMAT FIXER
      effectiveText = effectiveText.replace(
        /(\d{1,2}\s*[a-z]{3,9})\s*[\/]\s*(\d{1,2}\s*[a-z]{3,9})/gim, 
        '$1 to $2'
      );

      // 🛡️ 2. FORCE MERGE CHECK-IN / CHECK-OUT PAIRS
      effectiveText = effectiveText.replace(
        /(?:check\s*[-]?\s*(?:in|inn|int)|arr|arrival|from)\s*[:\s-]*(\d{1,2}\s*[a-z]{3,9}.*?)\s*\n\s*(?:check\s*[-]?\s*(?:out|outt)|dep|departure|to)\s*[:\s-]*(\d{1,2}\s*[a-z]{3,9}.*?)(?=$|\n)/gim,
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

      const universalTypes = extractRoomTypesFromText(rawText);

      // Final regex cleanup for tight multi-line dates
      effectiveText = effectiveText.replace(
        /(\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\s*\n\s*(\d{1,2}\s*\2)/i,
        '$1 to $3'
      )

      let segmentation
      try {
        segmentation = await segmentClientQuery(effectiveText)
      } catch (err) {
        for (const owner of getOwnerGroups()) {
          await sock.sendMessage(owner, { text: `⚠️ Segmentation failed\n${err.message}` })
        }
        return
      }

      let { blocks, global } = segmentation || {}
      global = global || {}

      if (Array.isArray(blocks)) {
        blocks = blocks
          .map(b => ({
            ...b,
            dates: (b.dates || '').trim(),
            hotels: Array.isArray(b.hotels) ? b.hotels.map(h => h.trim()).filter(Boolean) : []
          }))
          .filter(b => b.dates || b.hotels.length)
      }

      // 🛡️ DATE SPAM GUARD
      if (Array.isArray(blocks) && blocks.length > 5) {
        const firstDate = blocks[0].dates;
        const lastDate = blocks[blocks.length - 1].dates;
        const firstHotel = blocks[0].hotels?.[0];
        if (firstHotel && blocks.every(b => !b.hotels.length || b.hotels[0] === firstHotel)) {
          const cleanFirst = firstDate.split('to')[0].trim();
          const cleanLast = lastDate.split('to').pop().trim();
          blocks = [{ dates: `${cleanFirst} to ${cleanLast}`, hotels: [firstHotel] }];
        }
      }

      // Fill in hotel names if missing in block
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
      
      // Global Fallback
      const globalDateRanges = [];
      const dateRegex = /(\d{1,2})[\s-]*(?:to|[-/]|and)[\s-]*(\d{1,2})[\s-]*([a-z]{3,9})/gi;
      let dateMatch;
      while ((dateMatch = dateRegex.exec(effectiveText)) !== null) {
          globalDateRanges.push(`${dateMatch[1]} ${dateMatch[3]} to ${dateMatch[2]} ${dateMatch[3]}`);
      }

      // --- START OF FIXED BLOCK LOOP ---
      for (const block of blocks) {
        
        let blockDateList = [];
        if (block.dates) {
          const rawLines = block.dates.split('\n').map(l => l.trim()).filter(Boolean);
          const cleanLines = rawLines.map(l => 
            l.replace(/^(check\s*[-]?\s*(in|out|inn)|arr|dep|arrival|departure|from|to)[:\s-]*/i, '').trim()
          );

          const mergedDates = [];
          for (let i = 0; i < cleanLines.length; i++) {
            const current = cleanLines[i];
            const next = cleanLines[i+1];
            if (next && isPureDateLine(current) && isPureDateLine(next) && !current.toLowerCase().includes('to')) {
              mergedDates.push(`${current} to ${next}`);
              i++; 
            } else {
               if (isPureDateLine(current) || current.includes('to') || current.includes('-')) {
                  mergedDates.push(current);
               }
            }
          }
          blockDateList = mergedDates;
        }

        if (blockDateList.length === 0 && globalDateRanges.length > 0) {
           blockDateList = globalDateRanges;
        }

        // 2. SPLIT HOTELS
        let rawHotelList = block.hotels || [];
        let splitHotels = [];
        for (const rh of rawHotelList) {
          const parts = rh.split(/\s*\/\s*|\s+or\s+|\s*&\s*|,\s*/i).map(h => h.trim()).filter(Boolean);
          splitHotels.push(...parts);
        }

        // 3. PROCESS EACH HOTEL
        for (const hotelName of splitHotels) {
          const hotel = normalizeHotelForAI(hotelName);
          if (!hotel) continue;

          // Find context line but ALSO pass full text
          const fullLineFromText = effectiveText.split('\n').find(line => 
            line.toLowerCase().includes(hotelName.toLowerCase())
          ) || hotelName;

          const lineTypes = extractRoomTypesFromText(fullLineFromText);
          const activeTypes = lineTypes.length > 0 ? lineTypes : universalTypes;

          const mealHint = extractMeal(effectiveText);
          const viewHint = extractView(effectiveText);

          // 4. CROSS-MATCH
          for (const dateRange of blockDateList) {
            
            const aiInputLines = [
              `DATES: ${dateRange}`,
              `HOTEL: ${hotel}`,
              `FULL_CONTEXT: ${effectiveText}`, 
              `ROOMS_HINT: ${activeTypes.join(' ')}`,
              `MEAL_HINT: ${mealHint}`,
              `VIEW_HINT: ${viewHint}`,
              `STRICT: Extract check_in and check_out for ${dateRange} ONLY.`,
              `CRITICAL: Only include meal/view if they appear NEAR the hotel '${hotel}' or apply to the whole group.`
            ];

            const aiInput = protectDoubleTreeHotel(aiInputLines.join('\n').trim());
            
            let ai;
            try { 
              ai = await parseClientMessageWithAI(aiInput);
            } catch (err) { continue; }

            if (!ai?.queries) continue;

            for (const qRaw of ai.queries) {
              const q = { ...qRaw };
              
              if (dateRange.includes('to') && q.check_in === q.check_out) continue;
              if (!dateRange.includes('to') && q.check_in === q.check_out) {
                 const isOneNightExplicit = /\b(1|one)\s*night\b/i.test(effectiveText);
                 if (!isOneNightExplicit) continue; 
              }

              if (q.confidence === 0) continue;

              q.hotel = hotel;

              // Apply Hints
              if (!q.meal && mealHint) q.meal = mealHint;
              if (!q.view && viewHint) q.view = viewHint;

              // ---------------------------------------------------------
              // 👑 ROOM TYPE LOGIC (FIXED: Combines "Royal Suite" + "7 Pax")
              // ---------------------------------------------------------

              // 1. Force Upgrade to Complex Type (e.g. "ROYAL SUITE")
              if (activeTypes.length > 0) {
                 const bestMatch = activeTypes.find(t => 
                   q.room_type.toUpperCase().includes(t) || t.includes(q.room_type.toUpperCase())
                 );
                 if (bestMatch && bestMatch.length > q.room_type.length) {
                    q.room_type = bestMatch;
                 } else if (activeTypes.length === 1 && /^(SUITE|ROOM|QUAD|TRIPLE|DOUBLE)$/i.test(q.room_type)) {
                    q.room_type = activeTypes[0];
                 }
              }

              // 2. Append Pax for Large Groups (The Fix)
              if (typeof q.persons === 'number' && q.persons >= 5) {
                 const paxString = `${q.persons}`;
                 if (!q.room_type.includes(paxString)) {
                    q.room_type = `${q.room_type} ${q.persons} PAX`;
                 }
              }
              
              // 3. Final Fallbacks
              if (!q.room_type || !q.room_type.trim()) q.room_type = 'DOUBLE';
              if (!q.rooms || q.rooms < 1) q.rooms = 1;
              // ---------------------------------------------------------

              if (q.check_in && !q.check_out && dateRange) {
                const m = dateRange.match(/(\d{1,2}).*(to|-|\/|and).*(\d{1,2})/i);
                if (m) {
                  const day = m[m.length - 1].trim().padStart(2, '0');
                  q.check_out = q.check_in.replace(/\d{2}$/, day);
                }
              }

              if (q.check_in && q.check_out) {
                allQueries.push(q);
              }
            }
          } 
        } 
      } 
      // --- END OF FIXED BLOCK LOOP ---

      if (!allQueries.length) {
        for (const owner of getOwnerGroups()) {
          await sock.sendMessage(owner, { text: '⚠️ Booking rejected (no valid queries after normalization)' }, { quoted: msg })
        }
        return
      }

      await sock.sendMessage(groupId, { text: 'checking' }, { quoted: msg })

      const seen = new Set()
      const finalQueries = allQueries.filter(q => {
        const k = `${q.hotel}|${q.check_in}|${q.check_out}|${q.rooms}|${q.room_type}|${q.view}|${q.meal}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })

      for (const q of finalQueries) {
        const child = createChild({ parentId: parent.id, parsed: q })
        const vendors = getVendorsForHotel(q.hotel)
        console.log('📤 Sending to vendors:', q.hotel, '→', vendors)

        for (const vg of vendors) {
          const sent = await sock.sendMessage(vg, { text: formatQueryForVendor(child) })
          if (sent?.key?.id) linkVendorMessage(child.id, sent.key.id)
          await sleep(VENDOR_SEND_DELAY_MS)
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