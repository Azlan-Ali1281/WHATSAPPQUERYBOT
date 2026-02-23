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
async function calculateQuote(childQuery, vendorText, preParsedData = null) {
    // 🔍 Debug: Verify what data reached the calculator

    const isLocalDB = !!preParsedData;
    
    // 🔍 Debug: Verify what data reached the calculator
    console.log(`🧪 CALC DEBUG: Client requested [${childQuery.meal || 'N/A'}] | isLocalDB: ${isLocalDB}`);

    console.log(`🧪 CALC DEBUG: Client requested [${childQuery.meal || 'N/A'}] | Vendor base is [${vendorText ? vendorText.toLowerCase().includes('ro') ? 'RO' : '??' : 'DB_JSON'}]`);

    // 🛡️ THE FIX: Use Local DB JSON if provided. ONLY call AI if it's a new vendor reply.
    let vendorData;
    if (preParsedData) {
        vendorData = preParsedData; // ⚡ INSTANT SPEED (Bypasses AI)
    } 
    else {
        // 🛡️ TRANSLATE HUMAN SHORTHAND FOR THE AI
        let safeVendorText = vendorText.replace(/\b(rest|rem|remaining)\b/gi, `remaining dates to ${childQuery.check_out}`);
        
        // 1. Translate "430/500" into "Weekday 430, Weekend 500"
        safeVendorText = safeVendorText.replace(/\b(\d{3,5})\s*\/\s*(\d{3,5})\b/g, "Weekday $1, Weekend $2");
        
        // 2. Translate date slashes "25/27 feb" into "25 to 27 feb"
        safeVendorText = safeVendorText.replace(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/g, "$1 to $2");
        
        console.log(`🤖 TRANSLATED TEXT FOR AI:\n${safeVendorText}`);
        vendorData = await parseVendorMessageWithAI(safeVendorText, childQuery); 
    }
    
    if (!vendorData) return null;
    
    // 🛡️ GATE 0: AI VALIDATION CHECK
    if (vendorData.is_valid === false) {
        console.log("🚫 V2 REJECTED: AI marked this quote as invalid (wrong hotel or nonsensical data).");
        return null;
    }

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

    // 🛡️ (Gate 1.5 has been intentionally removed so we DO NOT overwrite the client's requested room type!)

// ======================================================
    // 🛡️ GATE 2: DATE INTEGRITY GUARD (With Anti-Hallucination)
    // ======================================================
    let vendorStartDate = null;
    let vendorEndDate = null;
    const allRates = vendorData.split_rates || vendorData.rates || [];

// 🛡️ ANTI-HALLUCINATION: Did the vendor actually type dates?
    // We check for months, slash dates, AND shorthand boundaries like "from 27", "to 5", "until 12"
    const vendorMentionedDates = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[\/\-]\d{1,2}|\b(from|to|till|until|starting)\s*\d{1,2}\b)/i.test(vendorText);

    // If live vendor didn't type dates, OVERRIDE the AI's hallucination to cover the whole stay
    if (!vendorMentionedDates && !isLocalDB) {
        console.log(`⚠️ CALC: Vendor provided no dates. Overriding AI hallucination to cover full stay.`);
        allRates.forEach(r => {
            if (r.dates) r.dates = `${childQuery.check_in} to ${childQuery.check_out}`;
        });
    }

    allRates.forEach(r => {
        if (r.dates && r.dates.includes(' to ')) {
            const [s, e] = r.dates.split(' to ');
            if (!vendorStartDate || s < vendorStartDate) vendorStartDate = s;
            if (!vendorEndDate || e > vendorEndDate) vendorEndDate = e;
        }
    });

    // 🛡️ THE FIX: ALWAYS enforce the date boundary check.
    if (vendorStartDate && vendorEndDate) {
        const qStart = childQuery.check_in;
        const qEnd = childQuery.check_out;
        
        if (vendorStartDate > qStart || vendorEndDate < qEnd) {
            console.log(`🚫 V2 REJECTED: Date Mismatch. Query: ${qStart}/${qEnd} vs Vendor: ${vendorStartDate}/${vendorEndDate}`);
            return null;
        }
    }
        // ======================================================
    // 🧮 CALCULATION LOGIC (PER ROOM)
    // ======================================================
    if (allRates.length === 0) return null;

    const totalRooms = childQuery.rooms || 1;

    // 🛡️ 1. CLIENT'S ORIGINAL INTENT (How many people need to sleep?)
    const originalRt = (childQuery.room_type || 'DOUBLE').toUpperCase();
    let requestedPaxPerRoom = 2; 
    if (originalRt.includes('SINGLE')) requestedPaxPerRoom = 1;
    else if (originalRt.includes('TRIPLE') || originalRt.includes('TRP') || originalRt.includes('TPL')) requestedPaxPerRoom = 3;
    else if (originalRt.includes('QUAD') || originalRt.includes('QAD')) requestedPaxPerRoom = 4;
    else if (originalRt.includes('QUINT')) requestedPaxPerRoom = 5;
    else if (originalRt.includes('SUITE') || originalRt.includes('FAMILY')) {
        requestedPaxPerRoom = Math.ceil((childQuery.persons || 4) / totalRooms);
    } else {
        requestedPaxPerRoom = Math.ceil((childQuery.persons || 2) / totalRooms);
    }

    // 🛡️ 2. VENDOR BASE CAPACITY LOCK
// 🛡️ 2. VENDOR BASE CAPACITY LOCK
    let vendorBaseCap = vendorData.quoted_base_capacity || 2;
    const lowerVendorText = vendorText.toLowerCase();
    
    if (/\b(sgl|single)\b/.test(lowerVendorText)) vendorBaseCap = 1;
    else if (/\b(dbl|double|tw|twin)\b/.test(lowerVendorText)) vendorBaseCap = 2;
    else if (/\b(trp|triple)\b/.test(lowerVendorText)) vendorBaseCap = 3;
    else if (/\b(quad|quard)\b/.test(lowerVendorText)) vendorBaseCap = 4;
    else if (/\b(quint)\b/.test(lowerVendorText)) vendorBaseCap = 5;

    // 🛡️ 3. EXTRA BEDS MATH
    let extraBedsPerRoom = 0;
    if (!vendorData.is_flat_rate && requestedPaxPerRoom > vendorBaseCap) {
        extraBedsPerRoom = requestedPaxPerRoom - vendorBaseCap;
    }

    console.log(`🛏️ CALC EB CHECK: requestedPax(${requestedPaxPerRoom}) - baseCap(${vendorBaseCap}) = extraBeds(${extraBedsPerRoom})`);
    const extraBedCostTotal = (vendorData.extra_bed_price || 0) * extraBedsPerRoom;

    // 2. SMART MEAL LOGIC (Clean & Fixed)
// 4. SMART MEAL LOGIC (FIXED: AI Base Meal Override)
    const rawMeal = childQuery.meal || childQuery.meal_plan || "";
    const clientRequestedMeal = rawMeal.toString().toUpperCase();
    const isClientAskingForMeal = /BB|HB|FB|BREAKFAST|IFTAR|SUHOOR/i.test(clientRequestedMeal);
    
    // 🛡️ THE FIX: If the vendor's raw text says "RO", we MUST override the AI. 
    // Sometimes the AI sees "BB 40" and mistakenly assumes the *base* plan is BB.
    let vendorBaseMeal = (vendorData.base_meal_plan || vendorData.meal_plan || 'RO').toUpperCase();
    if (/\b(ro|room only)\b/i.test(vendorText)) {
        vendorBaseMeal = 'RO';
    }

    const vendorChargesForMeal = vendorData.meal_price_per_pax > 0;

    let appliedMeal = ""; 
    let mealCostPerRoom = 0;

    // 🛡️ NEW LOGIC: If the base plan is NOT Room Only, AND they didn't charge extra for a meal, it's included!
    if (vendorBaseMeal !== 'RO' && !vendorChargesForMeal) {
        appliedMeal = vendorBaseMeal;
        mealCostPerRoom = 0; 
    } else {
        // If the base is RO, OR there's an explicit meal charge we need to apply
        if (isClientAskingForMeal && vendorChargesForMeal) {
            appliedMeal = clientRequestedMeal !== '' ? clientRequestedMeal : 'BB';
            // Multiply the meal price by the number of people in the room
            mealCostPerRoom = vendorData.meal_price_per_pax * requestedPaxPerRoom;
            console.log(`🍽️ MEAL ADDED: ${requestedPaxPerRoom} pax x ${vendorData.meal_price_per_pax} = ${mealCostPerRoom} SAR`);
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
    let totalExtraBedCostAllNights = 0; // 🛡️ NEW: Track extra bed costs across all nights
    const breakdown = [];
    let currentDate = new Date(updatedQuery.check_in);
    const endDate = new Date(updatedQuery.check_out);

    const clientCode = getClientCode(updatedQuery.remote_jid) || 'DEFAULT';

    while (currentDate < endDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const dayOfWeek = currentDate.getDay();
        const isWeekend = WEEKEND_DAYS.includes(dayOfWeek);
        const targetType = isWeekend ? 'WEEKEND' : 'WEEKDAY';

        let matchedRateObj = allRates.find(r => {
            if (!r.dates) return false;
            const parts = r.dates.split(' to ');
            if (parts.length !== 2) return false;
            
            // 🛡️ THE FIX: If the AI output an exact single date (e.g. 27 to 27), we MUST use <=
            // If it output a normal range (25 to 27), we use < so it doesn't overlap the next block!
            const inRange = (parts[0] === parts[1]) 
                ? (dateStr >= parts[0] && dateStr <= parts[1])
                : (dateStr >= parts[0] && dateStr < parts[1]);
                
            return inRange && r.type === targetType;
        });

        if (!matchedRateObj) {
            matchedRateObj = allRates.find(r => {
                if (!r.dates) return false;
                const parts = r.dates.split(' to ');
                if (parts.length !== 2) return false;
                
                const inRange = (parts[0] === parts[1]) 
                    ? (dateStr >= parts[0] && dateStr <= parts[1])
                    : (dateStr >= parts[0] && dateStr < parts[1]);
                    
                return inRange;
            });
        }

        if (!matchedRateObj) {
            matchedRateObj = allRates.find(r => !r.dates && r.type === targetType);
            if (!matchedRateObj) matchedRateObj = allRates.find(r => !r.dates && r.type === 'BASE');
            if (!matchedRateObj) matchedRateObj = allRates[0];
        }
        
        const baseRate = matchedRateObj ? (matchedRateObj.rate || matchedRateObj.amount || 0) : 0;

        // 🛡️ THE FIX: Dynamic Extra Bed Math
        const nightlyExtraBedPrice = matchedRateObj.extra_bed_rate || vendorData.extra_bed_price || 0;

// 🚨 STRICT BLOCKER: NO FREE BEDS (ONLY FOR LOCAL DB REUSE!)
        // If we are reusing a past quote for a larger group, we MUST have an explicit extra bed price.
        // For live vendor replies, we assume their flat price covers the requested room type.
        if (isLocalDB && extraBedsPerRoom > 0 && nightlyExtraBedPrice === 0) {
            console.log(`🚫 V2 REJECTED: Local DB quote needs ${extraBedsPerRoom} extra bed(s), but has NO extra bed price.`);
            return null; 
        }
        
        const currentExtraBedTotal = nightlyExtraBedPrice * extraBedsPerRoom;
        totalExtraBedCostAllNights += currentExtraBedTotal; // Add to our grand total

        const nightlyRoomRate = baseRate + viewSurcharge + currentExtraBedTotal;
        const netDailyTotal = nightlyRoomRate + mealCostPerRoom;

        console.log(`🧮 MATH DEBUG for ${dateStr}: Base(${baseRate}) + EB(${currentExtraBedTotal}) + View(${viewSurcharge}) + Meal(${mealCostPerRoom}) = ${netDailyTotal} SAR`);
        
        // 🛡️ APPLY MARKUP 
        const margin = getMarkup(clientCode, netDailyTotal);
        const finalSellingPrice = netDailyTotal + margin;

        totalCostOneRoom += finalSellingPrice;

        breakdown.push({
            date: dateStr,
            base_rate: baseRate,
            surcharges: viewSurcharge + currentExtraBedTotal, // 🛡️ Fix: Use dynamic surcharge
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
        room_type: childQuery.room_type, 
        offered_room_type: vendorData.offered_room_type, 
        applied_meal: appliedMeal,
        applied_view: appliedView,
        total_price: totalCostOneRoom, 
        breakdown: breakdown,
        vendor_text: vendorText,
        raw_vendor_data: vendorData,
        cost_breakdown: {
            meal_daily_per_room: mealCostPerRoom,
            view_daily_per_room: viewSurcharge,
            // 🛡️ THE FIX: Send the AVERAGE daily extra bed cost to the formatter
            eb_daily_per_room: extraBedsPerRoom > 0 ? Math.round(totalExtraBedCostAllNights / (breakdown.length || 1)) : 0,
            eb_qty: extraBedsPerRoom,
            margin_total: totalMargin 
        },
        calculation_debug: {
            is_flat: vendorData.is_flat_rate,
            pax_per_room: requestedPaxPerRoom, 
            vendor_base_capacity: vendorBaseCap,
            extra_beds_charged: extraBedsPerRoom,
            hotel_adapted: updatedQuery.hotel !== childQuery.hotel,
            client_code: clientCode
        }
    };
}

module.exports = { calculateQuote };