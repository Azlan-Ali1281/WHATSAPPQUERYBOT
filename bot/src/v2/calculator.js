// src/v2/calculator.js
const { parseVendorMessageWithAI } = require('./aiVendorParser');

const WEEKEND_DAYS = [4, 5]; // Thu, Fri

/**
 * 🧮 V2 CALCULATOR (Split Stay Edition)
 */
async function calculateQuote(childQuery, vendorText) {
  const vendorData = await parseVendorMessageWithAI(vendorText);
  
  // 🛡️ SAFETY CHECK: Handle both old 'rates' and new 'split_rates' formats
  if (!vendorData) return null;
  
  // Normalize everything to 'split_rates'
  let ratesList = vendorData.split_rates || vendorData.rates || [];
  if (ratesList.length === 0) return null;

  // 1. Setup Add-ons
  let appliedMeal = vendorData.meal_plan || childQuery.meal || 'RO';
  let mealCostPerNight = 0;
  if (vendorData.meal_price_per_pax > 0) {
      appliedMeal = vendorData.meal_plan || appliedMeal; 
      mealCostPerNight = vendorData.meal_price_per_pax * (childQuery.persons || 2);
  }

  // 2. Setup View Surcharge
  let appliedView = vendorData.view_surcharges?.[childQuery.view?.toLowerCase()] 
      ? childQuery.view 
      : (childQuery.view || 'City View');

  let viewSurcharge = 0;
  if (vendorData.view_surcharges) {
      if (appliedView.toLowerCase().includes('kaaba')) viewSurcharge = vendorData.view_surcharges.kaaba || 0;
      else if (appliedView.toLowerCase().includes('haram')) viewSurcharge = vendorData.view_surcharges.haram || 0;
      else if (appliedView.toLowerCase().includes('city')) viewSurcharge = vendorData.view_surcharges.city || 0;
  }

  // 3. Setup Extra Beds
  const rooms = childQuery.rooms || 1;
  const pax = childQuery.persons || (rooms * 2);
  const paxPerRoom = Math.ceil(pax / rooms);
  let extraBedsPerRoom = 0;
  if (!vendorData.is_flat_rate && paxPerRoom > 2) {
      extraBedsPerRoom = paxPerRoom - 2;
  }

  // 4. THE MATH LOOP
  let totalCost = 0;
  const breakdown = [];
  let currentDate = new Date(childQuery.check_in);
  const endDate = new Date(childQuery.check_out);

  while (currentDate < endDate) {
    const dateStr = currentDate.toISOString().split('T')[0]; // "2026-03-01"
    const dayOfWeek = currentDate.getDay();

    // --- LOGIC: FIND MATCHING RATE FOR THIS DATE ---
    let matchedRateObj = null;

    // A. Check specific date ranges first (Priority)
    matchedRateObj = ratesList.find(r => {
        if (!r.dates) return false; 
        
        // Robust split: Handle " to ", " - ", or just single date
        const parts = r.dates.split(/ to | - /);
        if (parts.length === 2) {
             const [start, end] = parts;
             return dateStr >= start && dateStr < end;
        }
        return false;
    });

    // B. Fallback to Global Rate
    if (!matchedRateObj) {
        const isWeekend = WEEKEND_DAYS.includes(dayOfWeek);
        matchedRateObj = ratesList.find(r => 
            !r.dates && (r.type === (isWeekend ? 'WEEKEND' : 'WEEKDAY') || r.type === 'BASE')
        );
        
        // Final Fallback: First available
        if (!matchedRateObj) matchedRateObj = ratesList[0];
    }

    // SUPPORT BOTH 'rate' AND 'amount' KEYS
    const baseRate = matchedRateObj ? (matchedRateObj.rate || matchedRateObj.amount || 0) : 0;
    const extraBedPrice = vendorData.extra_bed_price || 0;

    // --- CALCULATION ---
    const nightlyRoomRate = baseRate + viewSurcharge + (extraBedPrice * extraBedsPerRoom);
    const dailyTotal = (nightlyRoomRate * rooms) + mealCostPerNight;

    totalCost += dailyTotal;

    breakdown.push({
        date: dateStr,
        base_rate: baseRate,
        surcharges: viewSurcharge + (extraBedPrice * extraBedsPerRoom),
        meal_cost: mealCostPerNight,
        final_daily: dailyTotal
    });
    
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return {
    ...childQuery,
    applied_meal: appliedMeal,
    applied_view: appliedView,
    total_price: totalCost,
    breakdown: breakdown,
    vendor_text: vendorText,
    calculation_debug: {
        is_flat: vendorData.is_flat_rate,
        extra_beds_used: extraBedsPerRoom,
        rates_found: ratesList.length
    }
  };
}

module.exports = { calculateQuote };