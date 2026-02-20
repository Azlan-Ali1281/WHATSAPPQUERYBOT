// src/v2/calculator.js
const { parseVendorMessageWithAI } = require('./aiVendorParser');
const { sanitizeHotelNames } = require('../aiSanitizer'); 
const { getMarkup } = require('./markupEngine');
const { getClientCode } = require('../database');

// 🛡️ NOTE: Thursday (4) and Friday (5) are the standard Saudi hospitality weekend days.
const WEEKEND_DAYS = [4, 5]; 

/**
 * 🧮 V2 CALCULATOR (Adaptive, Strict & Profitable)
 * Calculates the cost for ONE room and applies tiered profit markups.
 */
async function calculateQuote(childQuery, vendorText) {
    // 🔍 Debug: Verify what data reached the calculator
    console.log(`🧪 CALC DEBUG: Client requested [${childQuery.meal || 'N/A'}] | Vendor base is [${vendorText.toLowerCase().includes('ro') ? 'RO' : '??'}]`);

    // 🛡️ Pass childQuery to AI so it knows the context for dates and hotel names
    const vendorData = await parseVendorMessageWithAI(vendorText, childQuery);
    
    if (!vendorData) return null;
    let updatedQuery = { ...childQuery };

    // ======================================================
    // 🛡️ GATE 1: HOTEL ADAPTATION
    // ======================================================
    if (vendorData.hotel) {
        const sanitizedVendorHotels = await sanitizeHotelNames([vendorData.hotel]);
        const sanitizedVendorHotel = sanitizedVendorHotels[0] || vendorData.hotel;

        if (sanitizedVendorHotel !== childQuery.hotel) {
            console.log(`🔄 V2 ADAPTED: Hotel switched from "${childQuery.hotel}" to "${sanitizedVendorHotel}"`);
            updatedQuery.hotel = sanitizedVendorHotel;
        }
    }

    // ======================================================
    // 🛡️ GATE 2: DATE INTEGRITY GUARD
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

    const totalRooms = updatedQuery.rooms || 1;
    let totalPax = updatedQuery.persons || (totalRooms * 2);
    let paxPerRoom = Math.ceil(totalPax / totalRooms);

    // 🛡️ Determine requested capacity to prevent undercounting pax for TRP/QUAD
    const rt = (updatedQuery.room_type || 'DOUBLE').toUpperCase();
    let requestedCapacity = 2; 
    if (rt.includes('SINGLE')) requestedCapacity = 1;
    else if (rt.includes('TRIPLE') || rt.includes('TRP') || rt.includes('TPL')) requestedCapacity = 3;
    else if (rt.includes('QUAD') || rt.includes('QAD')) requestedCapacity = 4;
    else if (rt.includes('QUINT')) requestedCapacity = 5;

    // 🚨 Force pax count to match room size if AI undercounted
    if (paxPerRoom < requestedCapacity) paxPerRoom = requestedCapacity;

    // 1. Extra Beds Math
    let extraBedsPerRoom = 0;
    const vendorBaseCap = vendorData.quoted_base_capacity || 2;
    if (!vendorData.is_flat_rate && paxPerRoom > vendorBaseCap) {
        extraBedsPerRoom = paxPerRoom - vendorBaseCap;
    }
    const extraBedCostTotal = (vendorData.extra_bed_price || 0) * extraBedsPerRoom;

    // 2. SMART MEAL LOGIC (Clean & Fixed)
    const rawMeal = childQuery.meal || childQuery.meal_plan || "";
    const clientRequestedMeal = rawMeal.toString().toUpperCase();

    // 🛡️ Check: Is the client explicitly asking for a meal?
    const isClientAskingForMeal = /BB|HB|FB|BREAKFAST|IFTAR|SUHOOR/i.test(clientRequestedMeal);
    
    const vendorBaseMeal = (vendorData.base_meal_plan || vendorData.meal_plan || 'RO').toUpperCase();
    const vendorChargesForMeal = vendorData.meal_price_per_pax > 0;

    let appliedMeal = ""; 
    let mealCostPerRoom = 0;

    if (vendorBaseMeal !== 'RO') {
        // Industry Rule: If vendor base includes meal (e.g., BB), it's included for everyone in the room.
        appliedMeal = vendorBaseMeal;
        mealCostPerRoom = 0; 
    } else {
        // Vendor base is RO
        if (isClientAskingForMeal && vendorChargesForMeal) {
            // Client wants it, Vendor sells it -> CHARGE IT per person
            appliedMeal = clientRequestedMeal;
            mealCostPerRoom = vendorData.meal_price_per_pax * paxPerRoom;
            console.log(`🍽️ MEAL ADDED: ${paxPerRoom} pax x ${vendorData.meal_price_per_pax} = ${mealCostPerRoom}`);
        } else {
            appliedMeal = 'RO';
            mealCostPerRoom = 0;
        }
    }

    // --- 🏙️ View Surcharge Logic ---
    let appliedView = (childQuery.view || 'CITY VIEW').toUpperCase();
    let viewSurcharge = 0;
    
    if (vendorData.view_surcharges) {
        if (appliedView.includes('KAABA')) viewSurcharge = vendorData.view_surcharges.kaaba || 0;
        else if (appliedView.includes('HARAM')) viewSurcharge = vendorData.view_surcharges.haram || 0;
        else if (appliedView.includes('CITY')) viewSurcharge = vendorData.view_surcharges.city || 0;
    }

    // 4. The Math Loop & Markup Application
    let totalCostOneRoom = 0;
    const breakdown = [];
    let currentDate = new Date(updatedQuery.check_in);
    const endDate = new Date(updatedQuery.check_out);

    // Get Client Code (Defaults to 'DEFAULT' if not linked)
    const clientCode = getClientCode(updatedQuery.remote_jid) || 'DEFAULT';

    while (currentDate < endDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const dayOfWeek = currentDate.getDay();
        const isWeekend = WEEKEND_DAYS.includes(dayOfWeek);
        const targetType = isWeekend ? 'WEEKEND' : 'WEEKDAY';

        // Find the correct rate for this date
        let matchedRateObj = allRates.find(r => {
            if (!r.dates) return false;
            const parts = r.dates.split(' to ');
            const inDateRange = parts.length === 2 && dateStr >= parts[0] && dateStr < parts[1];
            return inDateRange && r.type === targetType;
        });

        if (!matchedRateObj) {
            matchedRateObj = allRates.find(r => {
                if (!r.dates) return false;
                const parts = r.dates.split(' to ');
                return parts.length === 2 && dateStr >= parts[0] && dateStr < parts[1];
            });
        }

        if (!matchedRateObj) {
            matchedRateObj = allRates.find(r => !r.dates && r.type === targetType);
            if (!matchedRateObj) matchedRateObj = allRates.find(r => !r.dates && r.type === 'BASE');
            if (!matchedRateObj) matchedRateObj = allRates[0];
        }
        
        const baseRate = matchedRateObj ? (matchedRateObj.rate || matchedRateObj.amount || 0) : 0;
        const nightlyRoomRate = baseRate + viewSurcharge + extraBedCostTotal;
        const netDailyTotal = nightlyRoomRate + mealCostPerRoom;

        // 🛡️ APPLY MARKUP (Tiered logic: +20 for <1000, +40 for >=1000)
        const margin = getMarkup(clientCode, netDailyTotal);
        const finalSellingPrice = netDailyTotal + margin;

        totalCostOneRoom += finalSellingPrice;

        breakdown.push({
            date: dateStr,
            base_rate: baseRate,
            surcharges: viewSurcharge + extraBedCostTotal,
            meal_cost: mealCostPerRoom,
            net_daily: netDailyTotal,
            margin_added: margin,
            final_daily: finalSellingPrice
        });
        
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    const totalMargin = breakdown.reduce((sum, day) => sum + day.margin_added, 0);

    return {
        ...updatedQuery, 
        applied_meal: appliedMeal,
        applied_view: appliedView,
        total_price: totalCostOneRoom, // Selling Price (Net + Margin)
        breakdown: breakdown,
        vendor_text: vendorText,
        cost_breakdown: {
            meal_daily_per_room: mealCostPerRoom,
            view_daily_per_room: viewSurcharge,
            eb_daily_per_room: extraBedCostTotal,
            eb_qty: extraBedsPerRoom,
            margin_total: totalMargin // Total Profit for the stay
        },
        calculation_debug: {
            is_flat: vendorData.is_flat_rate,
            pax_per_room: paxPerRoom,
            vendor_base_capacity: vendorBaseCap,
            extra_beds_charged: extraBedsPerRoom,
            hotel_adapted: updatedQuery.hotel !== childQuery.hotel,
            client_code: clientCode
        }
    };
}

module.exports = { calculateQuote };