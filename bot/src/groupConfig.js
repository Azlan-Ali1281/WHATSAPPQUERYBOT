/**
 * GROUP REGISTRY
 * ---------------
 * Production-friendly configuration using SHORT NUMERIC CODES
 */

// ======================
// CLIENT GROUPS
// ======================

const CLIENTS = {
  31: '120363402732966312@g.us', // MMT
  28: '120363318495685441@g.us', // FAUZ
  27: '120363365926008685@g.us', // SURE
  22: '120363307647306024@g.us', // Shine Star
  68: '120363419620852660@g.us', // NS TRAVEL
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
  101: '120363423088872253@g.us', //TEST
  16: '120363306102166734@g.us', //UN TRAVEL
  51: '120363419358131159@g.us', //WORLD VISIT
  15 : '120363321504929035@g.us',//ABID
  109: '120363302168956004@g.us', // DAW
  78: '120363403285078510@g.us', // EVENTICA
  54: '120363393564468120@g.us', // AL HADI
  48: '120363265181436578@g.us', // AL WAHA
  55: '120363417198496338@g.us', // SMJ
  88: '120363322939894335@g.us', // AL ASIF
  29: '120363343833236598@g.us', //KARVAN-E-Royal
  108: '120363316525917807@g.us', //YAHYA
  104: '120363314618782087@g.us', //DASHT
  67: '120363403498808203@g.us', //TALHA TEMPTATIONS
  35: '120363365263487755@g.us', //ROSHAN TRAVELS

}


// ======================
// VENDOR GROUPS
// ======================

const VENDORS = {
   900: '120363423848269620@g.us', //TEST
   901: '120363421799666970@g.us', // FlyUnique
   902: '120363312735747310@g.us', // HBA Trvl Hotel VS Nwtt
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
   915: '120363420882619412@g.us', // SERB
   916: '120363420601536045@g.us', //SEDRA
   917: '120363308383480158@g.us', //SMOOTH
   918: '120363315331091127@g.us', // IMS
   919: '120363320286132315@g.us', //UNIWORLD 
   920: '120363402200576408@g.us', //JANATAN
   921: '120363399150192081@g.us', //HAMMAD
   922: '120363347278514375@g.us', //TABARAK
   923: '120363336336214623@g.us', //MAYSAN
   
}

// ======================================================
// HOTEL → VENDOR CODES
// ======================================================

const HOTEL_VENDOR_MAP = {
    // ============================================================
    // 🕌 MADINAH - MARKAZIYA (CENTRAL AREA) - NORTH/MAIN
    // ============================================================
    'Anwar Al Madinah': [905, 909, 912],      // Merged: Anwar, Anwar Al Medina
    'Saja Al Madinah': [905, 909, 912],       // Merged: Saja Al Media
    'Pullman Zamzam Madinah': [906, 905, 901, 910],
    'Madinah Hilton': [918, 910],
    'Shahd Al Madinah': [901, 902],                   // (Formerly Sofitel)
    'The Oberoi Madina': [915],
    'Dar Al Taqwa': [902],
    'Dar Al Iman InterContinental': [918],
    'Dar Al Hijra InterContinental': [918],
    'Movenpick Madinah': [905, 909, 912],
    'Crowne Plaza Madinah': [913],
    'Leader Al Muna Kareem': [905],
    'Odst Al Madinah': [914, 902, 901],
    'Artal Al Munawara': [901, 902, 914],
    'Zowar International': [901, 902, 914],
    'Taiba Front': [923],
    'Aqeeq Madinah': [923, 915],
    'Frontel Al Harithia': [923, 918],
    'Dallah Taibah': [901, 905, 902],
    'Golden Tulip Al Zahabi': [901],
    'Al Mukhtara International': [914, 902, 901],
    'Al Haram Hotel': [915, 902],
    'Province Al Sham': [914],

    // ============================================================
    // 🕋 MAKKAH - CLOCK TOWER & ABRAJ AL BAIT
    // ============================================================
    'Fairmont Makkah Clock Royal Tower': [901,902,905,906,910,913,919],
    'Swissotel Makkah': [901,902,905,906,910,913,919],
    'Swissotel Al Maqam': [901,902,905,906,910,913,919],
    'Raffles Makkah Palace': [901,902,905,906,910,913,919],
    'Pullman Zamzam Makkah': [901,902,905,906,910,913,919],
    'Movenpick Hajar Tower': [901,902,905,906,910,913,919],
    'Al Marwa Rayhaan by Rotana': [901,902,905,906,910,913,919],
    'Makkah Hotel': [907, 908, 905, 902, 901], 
    'Makkah Towers': [907, 908, 905, 902, 901], 

    // ============================================================
    // 🕋 MAKKAH - JABAL OMAR & HARAM FRONTLINE
    // ============================================================
    'Hilton Makkah Convention': [910],
    'Hilton Suites Makkah': [901, 910],
    'Hyatt Regency Makkah': [922],
    'Conrad Makkah': [922, 901, 902],
    'Jabal Omar Marriott': [913, 905, 907],
    'Address Jabal Omar': [913, 922],
    'Sheraton Makkah Jabal Al Kaaba': [922],
    'DoubleTree by Hilton Makkah': [910],
    'Le Meridien Makkah': [90],                 // (The one near Haram)
    'Waqf Uthman': [914, 902, 901],                // Standardized from 'Waqf Usman'

    // ============================================================
    // 🚌 MAKKAH - SHUTTLE / AZIZIYAH / KUDAI / 3-4 STAR
    // ============================================================
    'Voco Makkah': [901, 902, 910, 911, 913], // Merged: VOCO, Vocco
    'Kiswa Towers': [910, 908, 906],
    'Elaf Ajyad': [902, 901],
    'Le Meridien Towers Makkah': [919],          // (Kudai - Shuttle)
    'Novotel Makkah Thakher City': [917],
    'Holiday Inn Makkah Al Aziziah': [919],
};
// ======================================================
// DEFAULT VENDOR CODES (UNKNOWN HOTELS)
// ======================================================

const DEFAULT_VENDOR_CODES = [900,901,905,902] //,901,902,905

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
// 🛡️ FIX: Added MAKKAH, MADINAH, MADINA to generic words
const GENERIC_WORDS = new Set([
  'HOTEL', 'TOWER', 'TOWERS', 'INN', 'SUITES', 'SUITE', 
  'RESORT', 'APARTMENT', 'APARTMENTS', 'AL', 'EL', 
  'MAKKAH', 'MADINAH', 'MADINA', 'MECCA', 'MEDINA'
]);

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