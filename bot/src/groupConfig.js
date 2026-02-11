/**
 * GROUP REGISTRY
 * ---------------
 * Production-friendly configuration using SHORT NUMERIC CODES
 */

// ======================
// CLIENT GROUPS
// ======================

const CLIENTS = {
  31: '120363402732966312@g.us', // Client #031
  28: '120363318495685441@g.us', // Client #028
  27: '120363365926008685@g.us', // Client #027
  22: '120363307647306024@g.us', // Client #022
  68: '120363419620852660@g.us', // Client #068
  50: '120363418165371511@g.us', //ETT
  56: '120363318225645510@g.us', // 360
  19: '120363333382742462@g.us', //IDEAL
  57: '120363413679734097@g.us', //HUJJAJ
  38: '120363367273180779@g.us', //HAMZA
  71: '120363418288464681@g.us', //GREEN WORLD
  102: '120363404629591682@g.us', // PSL
  52: '120363401398569190@g.us', //Musafirana
  47: '120363398132182401@g.us', //ABDULLAH
  69: '120363400986591876@g.us', //MEHER
  101: '120363423088872253@g.us',
  51: '120363419358131159@g.us', //WORLD VISIT
  15 : '120363321504929035@g.us',//ABID
  109: '120363302168956004@g.us', // DAW
  78: '120363403285078510@g.us', // EVENTICA
}


// ======================
// VENDOR GROUPS
// ======================

const VENDORS = {
   900: '120363423848269620@g.us',
   901: '120363421799666970@g.us', // FlyUnique
   902: '120363312735747310@g.us', // HBA Trvl Hotel VS Nwtt
   904: '120363265181436578@g.us', // HBA Travel (48) 🤝 Al Waha
   905: '120363297808806322@g.us', // Agent HBA PAK / ATT266
   906: '120363421038166711@g.us', // HBA 1540 🤝 ASKANT
   907: '120363422210264688@g.us', // HBA 🤝 KENZI HOSPITALITY 49
   908: '120363422656893710@g.us', // HBA-Imran Bhai
   909: '120363419322714295@g.us', // 475 HBA 🤝 ALSUBAEE HOLIDAYS
   910: '120363366561202735@g.us',  // Aden
   911: '120363404455208031@g.us', // Arkaan
   912: '120363421934695518@g.us', // HLT
   913: '120363299136246491@g.us', // WOSOL
   914: '120363314562298136@g.us', //RITAJ
}

// ======================================================
// HOTEL → VENDOR CODES
// ======================================================

const HOTEL_VENDOR_MAP = {
  // 'VOCO': [901, 902, 910, 911, 913],
  // 'Vocco' : [901, 902, 910, 911, 913],
  // 'Saja Al Media': [ 905 ,909 , 912],
  // 'Saja Al Medina' : [ 905 ,909 , 912],
  // 'Waqf Usman': [909 , 901],
  // 'Makkah Tower': [907,908,905,902, 901],
  // 'Makkah Hotel': [907,908,905,902, 901],
  // 'Anwar Al Medina': [ 905 ,909 , 912],
  // 'Anwar Al Madina': [ 905 ,909 , 912],
  // 'Anwar': [ 905 ,909 , 912],
}

// ======================================================
// DEFAULT VENDOR CODES (UNKNOWN HOTELS)
// ======================================================

const DEFAULT_VENDOR_CODES = [900] //,901,902,905

// ======================================================
// GROUP ROLES (DERIVED, DO NOT EDIT MANUALLY)
// ======================================================

const GROUP_ROLES = {
  // OWNER
  '120363406811283329@g.us': 'OWNER',

  // CLIENTS
  ...Object.fromEntries(
    Object.values(CLIENTS).map(gid => [gid, 'CLIENT'])
  ),

  // VENDORS
  ...Object.fromEntries(
    Object.values(VENDORS).map(gid => [gid, 'VENDOR'])
  )
}

// ==============================
// HELPERS
// ==============================

function getGroupRole(groupId) {
  return GROUP_ROLES[groupId] || 'UNKNOWN'
}

function getOwnerGroups() {
  return Object.keys(GROUP_ROLES).filter(
    gid => GROUP_ROLES[gid] === 'OWNER'
  )
}

// 1. Keep this the same
function normalizeHotelName(name) {
  return name
    ?.toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// 2. Updated to include common variations to ignore
const GENERIC_WORDS = new Set([
  'HOTEL', 'TOWER', 'TOWERS', 'INN', 'SUITES', 'SUITE', 
  'RESORT', 'APARTMENT', 'APARTMENTS', 'AL', 'EL'
])

function splitMeaningfulWords(text) {
  return text
    .split(' ')
    .filter(w => w.length >= 2 && !GENERIC_WORDS.has(w)) // Length >= 2 to catch short names
}

// 3. UPDATED MATCHING LOGIC
function getVendorsForHotel(hotelName) {
  const normalizedInput = normalizeHotelName(hotelName)
  let vendorCodes = DEFAULT_VENDOR_CODES

  if (normalizedInput) {
    const inputWords = splitMeaningfulWords(normalizedInput)

    // Find the best match in the map
    for (const key of Object.keys(HOTEL_VENDOR_MAP)) {
      const keyWords = splitMeaningfulWords(normalizeHotelName(key))
      
      // STRICT MATCH: Every meaningful word in the Map Key 
      // must exist in the User's Input
      const isFullMatch = keyWords.every(kw => 
        inputWords.includes(kw)
      )

      if (isFullMatch && keyWords.length > 0) {
        vendorCodes = HOTEL_VENDOR_MAP[key]
        break 
      }
    }
  }

  return vendorCodes
    .map(code => VENDORS[code])
    .filter(Boolean)
}

// ======================================================
// 🔑 CLIENT CODE FETCHER (NUMBER)
// ======================================================

function getClientCode(groupId) {
  const entry = Object.entries(CLIENTS)
    .find(([, gid]) => gid === groupId)
  return entry ? entry[0] : '000'
}

module.exports = {
  GROUP_ROLES,
  getGroupRole,
  getOwnerGroups,
  getVendorsForHotel,
  getClientCode
}