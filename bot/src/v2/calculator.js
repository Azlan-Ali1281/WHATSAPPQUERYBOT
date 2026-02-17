// src/v2/calculator.js
const { parseVendorMessageWithAI } = require('./aiVendorParser');
const { sanitizeHotelNames } = require('../aiSanitizer'); // ✅ Added Sanitizer Import

const WEEKEND_DAYS = [4, 5]; // Thu, Fri (Saudi Weekend)

/**
 * 🧮 V2 CALCULATOR (Adaptive & Strict Edition)
 * Calculates the cost for ONE room and validates vendor data integrity.
 */
async function calculateQuote(childQuery, vendorText) {
  const vendorData = await parseVendorMessageWithAI(vendorText);
  
  // 🛡️ SAFETY CHECK: Basic AI parsing failure
  if (!vendorData) return null;

  // Clone the query to allow updating the hotel name without breaking the original record
  let updatedQuery = { ...childQuery };

  // ======================================================
  // 🛡️ GATE 1: HOTEL ADAPTATION
  // ======================================================
  if (vendorData.hotel) {
      const sanitizedVendorHotels = await sanitizeHotelNames([vendorData.hotel]);
      const sanitizedVendorHotel = sanitizedVendorHotels[0] || vendorData.hotel;

      // If vendor quoted a different hotel, we update our local query copy
      if (sanitizedVendorHotel !== childQuery.hotel) {
          console.log(`🔄 V2 ADAPTED: Hotel switched from "${childQuery.hotel}" to "${sanitizedVendorHotel}"`);
          updatedQuery.hotel = sanitizedVendorHotel;
      }
  }

  // ======================================================
  // 🛡️ GATE 2: DATE INTEGRITY GUARD (Strict)
  // ======================================================
  let vendorStartDate = null;
  let vendorEndDate = null;
  const allRates = vendorData.split_rates || vendorData.rates || [];

  allRates.forEach(r => {
      if (r.dates && r.dates.includes(' to ')) {
          const [s, e] = r.dates.split(' to ');
          if (!vendorStartDate || s < vendorStartDate) vendorStartDate = s;
          if (!vendorEndDate || e > vendorEndDate) vendorEndDate = e;
      }
  });

  // 🚨 If the vendor provided specific dates that DON'T match your query, reject the quote.
  if (vendorStartDate && vendorEndDate) {
      const qStart = childQuery.check_in;
      const qEnd = childQuery.check_out;

      if (vendorStartDate !== qStart || vendorEndDate !== qEnd) {
          console.log(`🚫 V2 REJECTED: Date Mismatch. Query: ${qStart}/${qEnd} vs Vendor: ${vendorStartDate}/${vendorEndDate}`);
          return null;
      }
  }

  // ======================================================
  // 🧮 CALCULATION LOGIC (PER ROOM)
  // ======================================================
  if (allRates.length === 0) return null;

  // Determine Scope
  const totalRooms = updatedQuery.rooms || 1;
  const totalPax = updatedQuery.persons || (totalRooms * 2);
  const paxPerRoom = Math.ceil(totalPax / totalRooms);

  // Setup Add-ons (Meals)
  let appliedMeal = vendorData.meal_plan || updatedQuery.meal || 'RO';
  let mealCostPerRoom = 0;
  if (vendorData.meal_price_per_pax > 0) {
      mealCostPerRoom = vendorData.meal_price_per_pax * paxPerRoom;
  }

  // Setup View Surcharge
  let appliedView = vendorData.view_surcharges?.[updatedQuery.view?.toLowerCase()] 
      ? updatedQuery.view 
      : (updatedQuery.view || 'City View');

  let viewSurcharge = 0;
  if (vendorData.view_surcharges) {
      const v = appliedView.toLowerCase();
      if (v.includes('kaaba')) viewSurcharge = vendorData.view_surcharges.kaaba || 0;
      else if (v.includes('haram')) viewSurcharge = vendorData.view_surcharges.haram || 0;
      else if (v.includes('city')) viewSurcharge = vendorData.view_surcharges.city || 0;
  }

  // Setup Extra Beds
  let extraBedsPerRoom = 0;
  if (!vendorData.is_flat_rate && paxPerRoom > 2) {
      extraBedsPerRoom = paxPerRoom - 2;
  }
  const extraBedCostTotal = (vendorData.extra_bed_price || 0) * extraBedsPerRoom;

  // The Math Loop
  let totalCostOneRoom = 0;
  const breakdown = [];
  let currentDate = new Date(updatedQuery.check_in);
  const endDate = new Date(updatedQuery.check_out);

  while (currentDate < endDate) {
    const dateStr = currentDate.toISOString().split('T')[0];
    const dayOfWeek = currentDate.getDay();

    // A. Match specific date range
    let matchedRateObj = allRates.find(r => {
        if (!r.dates) return false;
        const parts = r.dates.split(' to ');
        return parts.length === 2 && dateStr >= parts[0] && dateStr < parts[1];
    });

    // B. Fallback to Weekend/Weekday/Base
    if (!matchedRateObj) {
        const isWeekend = WEEKEND_DAYS.includes(dayOfWeek);
        matchedRateObj = allRates.find(r => 
            !r.dates && (r.type === (isWeekend ? 'WEEKEND' : 'WEEKDAY') || r.type === 'BASE')
        );
        if (!matchedRateObj) matchedRateObj = allRates[0];
    }

    const baseRate = matchedRateObj ? (matchedRateObj.rate || matchedRateObj.amount || 0) : 0;
    const nightlyRoomRate = baseRate + viewSurcharge + extraBedCostTotal;
    const dailyTotal = nightlyRoomRate + mealCostPerRoom;

    totalCostOneRoom += dailyTotal;

    breakdown.push({
        date: dateStr,
        base_rate: baseRate,
        surcharges: viewSurcharge + extraBedCostTotal,
        meal_cost: mealCostPerRoom,
        final_daily: dailyTotal
    });
    
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return {
    ...updatedQuery, // ✅ Returns the adapted hotel name
    applied_meal: appliedMeal,
    applied_view: appliedView,
    total_price: totalCostOneRoom,
    breakdown: breakdown,
    vendor_text: vendorText,
    calculation_debug: {
        is_flat: vendorData.is_flat_rate,
        pax_per_room: paxPerRoom,
        extra_beds_charged: extraBedsPerRoom,
        hotel_adapted: updatedQuery.hotel !== childQuery.hotel
    }
  };
}

module.exports = { calculateQuote };