const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, 'savedRates.json');

function loadRates() {
  if (!fs.existsSync(jsonPath)) return [];
  try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } 
  catch (err) { return []; }
}

function isWeekend(dateObj) {
  const day = dateObj.getDay(); 
  return day === 4 || day === 5; 
}

function isDateInSeason(dateObj, seasonStart, seasonEnd) {
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  const currentMMDD = `${m}-${d}`;
  if (seasonStart <= seasonEnd) return currentMMDD >= seasonStart && currentMMDD <= seasonEnd;
  return currentMMDD >= seasonStart || currentMMDD <= seasonEnd;
}

function normalizeKey(text) {
  if (!text) return '';
  const t = text.toLowerCase();
  if (t.includes('kaaba')) return 'kaaba';
  if (t.includes('haram')) return 'haram';
  if (t.includes('city')) return 'city';
  
  // Meal Normalization
  if (t.includes('suhoor') && t.includes('iftar')) return 'suhoor_iftar';
  if (t.includes('suhoor') || t.includes('sehri')) return 'suhoor';
  if (t.includes('iftar')) return 'iftar';
  if (t.includes('bb') || t.includes('breakfast')) return 'bb';
  if (t.includes('hb') || t.includes('half')) return 'hb';
  if (t.includes('fb') || t.includes('full')) return 'fb';
  if (t.includes('ro') || t.includes('only')) return 'ro';
  return '';
}

function checkSavedRate(queryHotel, checkIn, checkOut, pax, roomType, requestedView, requestedMeal) {
  const allHotels = loadRates();
  const hotelData = allHotels.find(h => 
    h.hotel_info.name.toLowerCase() === queryHotel.toLowerCase() || 
    h.hotel_info.aliases.some(a => queryHotel.toLowerCase().includes(a.toLowerCase()))
  );

  if (!hotelData) return null;

  let currentDate = new Date(checkIn);
  const end = new Date(checkOut);
  if (isNaN(currentDate.getTime()) || isNaN(end.getTime())) return null;

  const rules = hotelData.rate_rules;
  const surcharges = rules.surcharges || { views: {}, meals: {} };
  
  const viewKey = normalizeKey(requestedView);
  const viewCost = surcharges.views[viewKey] || 0;

  // 1. Determine Meal Rate Per Person
  let mealKey = normalizeKey(requestedMeal);
  let perPersonMealRate = 0;
  let finalMealLabel = 'RO';

  if (rules.meal_included) {
    finalMealLabel = rules.included_meal_type || 'BB';
    perPersonMealRate = 0; // Already in base
  } else if (mealKey && mealKey !== 'ro') {
    perPersonMealRate = surcharges.meals[mealKey] || 0;
    finalMealLabel = mealKey.toUpperCase().replace('_', ' + ');
  }

  // 2. FORCE PAX CHECK (Fix for Double/Single)
  // If the query is "Double", pax should be at least 2.
  let effectivePax = parseInt(pax) || 2;
  const rt = roomType.toUpperCase();
  if (rt.includes('DOUBLE') || rt.includes('DBL') || rt.includes('TWIN')) {
      if (effectivePax < 2) effectivePax = 2;
  } else if (rt.includes('TRIPLE') || rt.includes('TRP')) {
      if (effectivePax < 3) effectivePax = 3;
  } else if (rt.includes('QUAD')) {
      if (effectivePax < 4) effectivePax = 4;
  }

  let breakdown = [];
  let validSequence = true;

  while (currentDate < end) {
    const season = hotelData.seasons.find(s => isDateInSeason(currentDate, s.start, s.end));
    if (!season) { validSequence = false; break; }

    const isWknd = isWeekend(currentDate);
    const rateBlock = (isWknd && !rules.is_weekend_flat) ? season.rates.weekend : season.rates.weekday;
    
    let dailyBase = rateBlock.single_double;
    let dailyExtra = 0;

    // Extra Bed
    if (effectivePax > rules.flat_till_pax) {
       const extraBedsNeeded = effectivePax - rules.flat_till_pax;
       const costPerBed = (rateBlock.extra_bed !== undefined) ? rateBlock.extra_bed : (rules.default_extra_bed_rate || 0);
       dailyExtra = extraBedsNeeded * costPerBed;
    }

    // 🧮 CALCULATION
    const nightlyTotal = dailyBase + dailyExtra + viewCost + (perPersonMealRate * effectivePax);
    breakdown.push({ price: nightlyTotal });

    currentDate.setDate(currentDate.getDate() + 1);
  }

  if (!validSequence || breakdown.length === 0) return null;

  return {
    hotel: hotelData.hotel_info.name,
    currency: "SAR",
    room_descriptor: roomType,
    applied_view: (viewKey && viewKey !== 'city') ? (requestedView || viewKey.toUpperCase()) : '', 
    applied_meal: finalMealLabel,
    breakdown: breakdown 
  };
}

module.exports = { checkSavedRate };