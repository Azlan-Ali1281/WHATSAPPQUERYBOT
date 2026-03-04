const { getDatabase } = require('./database'); // 🛡️ NEW: Import Database

function isWeekend(dateObj) {
  const day = dateObj.getDay(); 
  return day === 4 || day === 5; // Thursday & Friday
}

function isDateInSeason(dateObj, seasonStart, seasonEnd) {
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  const currentMMDD = `${m}-${d}`;
  if (seasonStart <= seasonEnd) return currentMMDD >= seasonStart && currentMMDD <= seasonEnd;
  return currentMMDD >= seasonStart || currentMMDD <= seasonEnd; // Wraps around New Year
}

function normalizeKey(text) {
  if (!text) return '';
  const t = text.toLowerCase();
  if (t.includes('kaaba')) return 'kaaba';
  if (t.includes('haram')) return 'haram';
  if (t.includes('city')) return 'city';
  
  // 🛡️ Meal Normalization Fix (Mapped to DB columns)
  if (t.includes('suhoor') && t.includes('iftar')) return 'suhoor_iftar';
  
  // Maps all suhoor variations to "sahour" to match your DB
  if (t.includes('suhoor') || t.includes('sehri') || t.includes('sahour') || t.includes('sohor')) return 'sahour';
  
  if (t.includes('iftar') || t.includes('aftari')) return 'iftar';
  if (t.includes('bb') || t.includes('breakfast')) return 'bb';
  if (t.includes('hb') || t.includes('half')) return 'hb';
  if (t.includes('fb') || t.includes('full')) return 'fb';
  if (t.includes('ro') || t.includes('only')) return 'ro';
  return '';
}

function checkSavedRate(queryHotel, checkIn, checkOut, pax, roomType, requestedView, requestedMeal) {
  const db = getDatabase();

  // 1. Fetch all hotels to perform alias matching
  const allHotels = db.prepare("SELECT * FROM static_hotels").all();
  
  const hotelData = allHotels.find(h => {
      let aliases = [];
      try { aliases = JSON.parse(h.aliases); } catch(e) {}
      return h.hotel_name.toLowerCase() === queryHotel.toLowerCase() || 
             aliases.some(a => queryHotel.toLowerCase().includes(a.toLowerCase()));
  });

  if (!hotelData) return null; // Not a static rate hotel

  // 2. Fetch Seasons for this specific hotel
  const seasons = db.prepare("SELECT * FROM static_seasons WHERE hotel_id = ?").all(hotelData.hotel_id);

  let currentDate = new Date(checkIn);
  const end = new Date(checkOut);
  if (isNaN(currentDate.getTime()) || isNaN(end.getTime())) return null;

  // 3. Parse JSON Surcharges from DB
  let viewSurcharges = {};
  let mealSurcharges = {};
  try { viewSurcharges = JSON.parse(hotelData.view_surcharges); } catch(e) {}
  try { mealSurcharges = JSON.parse(hotelData.meal_surcharges); } catch(e) {}
  
  const viewKey = normalizeKey(requestedView);
  const viewCost = viewSurcharges[viewKey] || 0;

  // 4. Determine Meal Rate Per Person
  let mealKey = normalizeKey(requestedMeal);
  let perPersonMealRate = 0;
  let finalMealLabel = 'RO';

  if (hotelData.meal_included === 1) {
    finalMealLabel = hotelData.included_meal_type || 'BB';
    perPersonMealRate = 0; // Already in base rate
  } else if (mealKey && mealKey !== 'ro') {
    perPersonMealRate = mealSurcharges[mealKey] || 0;
    finalMealLabel = mealKey.toUpperCase().replace('_', ' + ');
  }

  // 5. FORCE PAX CHECK (Fix for Double/Single)
  let effectivePax = parseInt(pax) || 2;
  const rt = (roomType || '').toUpperCase();
  if (rt.includes('DOUBLE') || rt.includes('DBL') || rt.includes('TWIN')) {
      if (effectivePax < 2) effectivePax = 2;
  } else if (rt.includes('TRIPLE') || rt.includes('TRP')) {
      if (effectivePax < 3) effectivePax = 3;
  } else if (rt.includes('QUAD')) {
      if (effectivePax < 4) effectivePax = 4;
  } else if (rt.includes('QUINT')) {
      if (effectivePax < 5) effectivePax = 5;
  }

  let breakdown = [];
  let validSequence = true;

  // 6. Calculate Night by Night
  while (currentDate < end) {
    // Find matching season in DB array
    const season = seasons.find(s => isDateInSeason(currentDate, s.start_date, s.end_date));
    if (!season) { validSequence = false; break; }

    const isWknd = isWeekend(currentDate);
    const useWeekendRates = isWknd && hotelData.is_weekend_flat === 0;
    
    // Pull correct rates from DB Columns
    let dailyBase = useWeekendRates ? season.weekend_sd_rate : season.weekday_sd_rate;
    let costPerBed = useWeekendRates ? season.weekend_eb_rate : season.weekday_eb_rate;
    
    // Fallback to default extra bed rate if season doesn't specify one
    if (costPerBed === 0 || costPerBed === null) {
        costPerBed = hotelData.default_extra_bed_rate;
    }

    let dailyExtra = 0;

    // Calculate Extra Beds Needed
    if (effectivePax > hotelData.flat_till_pax) {
       const extraBedsNeeded = effectivePax - hotelData.flat_till_pax;
       dailyExtra = extraBedsNeeded * costPerBed;
    }

    // 🧮 FINAL CALCULATION
    const nightlyTotal = dailyBase + dailyExtra + viewCost + (perPersonMealRate * effectivePax);
    breakdown.push({ price: nightlyTotal });

    currentDate.setDate(currentDate.getDate() + 1);
  }

  if (!validSequence || breakdown.length === 0) return null;

  return {
    hotel: hotelData.hotel_name,
    currency: "SAR",
    room_descriptor: roomType,
    applied_view: (viewKey && viewKey !== 'city') ? (requestedView || viewKey.toUpperCase()) : '', 
    applied_meal: finalMealLabel,
    breakdown: breakdown 
  };
}

module.exports = { checkSavedRate };