const { parseVendorMessageWithAI } = require('./aiVendorParser');
const { sanitizeHotelNames } = require('../aiSanitizer'); 
const { getMarkup } = require('./markupEngine');
const { getGroupInfo } = require('../database'); // 🛡️ CRITICAL: Fetch full info for tier support

// 🛡️ NOTE: Thursday (4) and Friday (5) are the standard Saudi hospitality weekend days.
const WEEKEND_DAYS = [4, 5]; 

/**
 * 🧮 V2 CALCULATOR (Adaptive, Strict & Profitable)
 * Calculates the cost for ONE room and applies tiered profit markups.
 */
async function calculateQuote(childQuery, vendorText, preParsedData = null) {
    const isLocalDB = !!preParsedData;
    
    // 🔍 Debug: Verify what data reached the calculator
    console.log(`🧪 CALC DEBUG: Client requested [${childQuery.meal || 'N/A'}] | isLocalDB: ${isLocalDB}`);

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

// ======================================================
    // 🛡️ GATE 2: DATE INTEGRITY GUARD (STRICT MONTH LOCK)
    // ======================================================
    let vendorStartDate = null;
    let vendorEndDate = null;
    const allRates = vendorData.split_rates || vendorData.rates || [];

    // 1. Check if vendor text has date keywords
    const vendorMentionedDates = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[\/\-]\d{1,2}|\b(from|to|till|until|starting)\s*\d{1,2}\b)/i.test(vendorText);

    // 🛡️ THE FIX: Only "Assume" dates for LIVE vendor replies. 
    // For Local DB, if dates are missing or wrong, we reject it.
    if (!vendorMentionedDates && !isLocalDB) {
        console.log(`⚠️ CALC: Live Vendor provided no dates. Using query range.`);
        allRates.forEach(r => {
            if (r.dates) r.dates = `${childQuery.check_in} to ${childQuery.check_out}`;
        });
    }

    // 2. Extract dates from the rate objects
    allRates.forEach(r => {
        if (r.dates && r.dates.includes(' to ')) {
            const [s, e] = r.dates.split(' to ');
            if (!vendorStartDate || s < vendorStartDate) vendorStartDate = s;
            if (!vendorEndDate || e > vendorEndDate) vendorEndDate = e;
        }
    });

    // 🛡️ THE "MONTH KILLER": Absolute rejection if the year-month doesn't match
    if (vendorStartDate && vendorEndDate) {
        const queryMonth = childQuery.check_in.substring(0, 7); // "2026-11"
        const vendorMonth = vendorStartDate.substring(0, 7);   // "2026-03" (from DB)

        if (queryMonth !== vendorMonth && !vendorData.is_stitched) {
            console.log(`🚫 V2 REJECTED: Month Mismatch. Requested: ${queryMonth} vs DB: ${vendorMonth}`);
            return null; // Kill the quote
        }
    } else if (isLocalDB) {
        // If it's a DB quote and we couldn't find dates at all, kill it.
        console.log(`🚫 V2 REJECTED: Local DB quote has no date anchors.`);
        return null;
    }

    // 3. Final Range Validation
    if (vendorStartDate && vendorEndDate && !vendorData.is_stitched) {
        if (vendorStartDate > childQuery.check_in || vendorEndDate < childQuery.check_out) {
            console.log(`🚫 V2 REJECTED: Range too short.`);
            return null;
        }
    }

    // ======================================================
    // 🛡️ GATE 2.5: ZERO-RATE & FLAT-RATE PROTECTIONS
    // ======================================================
    if (allRates.some(r => r.rate <= 0)) {
        console.log(`🚫 V2 REJECTED: AI extracted a base rate of 0. Invalid quote.`);
        return null;
    }

    const involvesMarch = childQuery.check_in.includes('-03-') || childQuery.check_out.includes('-03-');
    
    if (involvesMarch) {
        const qStart = new Date(childQuery.check_in);
        const qEnd = new Date(childQuery.check_out);
        const totalNights = Math.round((qEnd - qStart) / (1000 * 60 * 60 * 24)) || 1;

        let packageOverrideTriggered = false;

        allRates.forEach(r => {
            if (r.rate > 4000) {
                console.log(`⚠️ OVERRIDE: March/Ashra Flat Rate detected (${r.rate} SAR). Dividing by ${totalNights} nights.`);
                r.rate = Math.round(r.rate / totalNights);
                
                if (r.extra_bed_rate > 0) {
                    r.extra_bed_rate = Math.round(r.extra_bed_rate / totalNights);
                }
                packageOverrideTriggered = true;
            }
        });

        if (packageOverrideTriggered && vendorData.extra_bed_price > 0) {
            console.log(`⚠️ OVERRIDE: Dividing global Extra Bed price (${vendorData.extra_bed_price} SAR) by ${totalNights} nights.`);
            vendorData.extra_bed_price = Math.round(vendorData.extra_bed_price / totalNights);
        }
    }

    // ======================================================
    // 🧮 CALCULATION LOGIC (PER ROOM)
    // ======================================================
    if (allRates.length === 0) return null;

    const totalRooms = childQuery.rooms || 1;

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

    let vendorBaseCap = vendorData.quoted_base_capacity || 2;
    const lowerVendorText = vendorText.toLowerCase();
    
    if (/\b(sgl|single)\b/.test(lowerVendorText)) vendorBaseCap = 1;
    else if (/\b(dbl|double|tw|twin)\b/.test(lowerVendorText)) vendorBaseCap = 2;
    else if (/\b(trp|triple)\b/.test(lowerVendorText)) vendorBaseCap = 3;
    else if (/\b(quad|quard)\b/.test(lowerVendorText)) vendorBaseCap = 4;
    else if (/\b(quint)\b/.test(lowerVendorText)) vendorBaseCap = 5;

    let extraBedsPerRoom = 0;
    if (!vendorData.is_flat_rate && requestedPaxPerRoom > vendorBaseCap) {
        extraBedsPerRoom = requestedPaxPerRoom - vendorBaseCap;
    }

    console.log(`🛏️ CALC EB CHECK: requestedPax(${requestedPaxPerRoom}) - baseCap(${vendorBaseCap}) = extraBeds(${extraBedsPerRoom})`);

    const rawMeal = childQuery.meal || childQuery.meal_plan || "";
    const clientRequestedMeal = rawMeal.toString().toUpperCase();
    const isClientAskingForMeal = /BB|HB|FB|BREAKFAST|IFTAR|SUHOOR/i.test(clientRequestedMeal);
    
    let vendorBaseMeal = (vendorData.base_meal_plan || vendorData.meal_plan || 'RO').toUpperCase();
    if (/\b(ro|room only)\b/i.test(vendorText)) {
        vendorBaseMeal = 'RO';
    }

    const vendorChargesForMeal = vendorData.meal_price_per_pax > 0;

    let appliedMeal = ""; 
    let mealCostPerRoom = 0;

    if (vendorBaseMeal !== 'RO' && !vendorChargesForMeal) {
        appliedMeal = vendorBaseMeal;
        mealCostPerRoom = 0; 
    } else {
        if (isClientAskingForMeal && vendorChargesForMeal) {
            appliedMeal = clientRequestedMeal !== '' ? clientRequestedMeal : 'BB';
            mealCostPerRoom = vendorData.meal_price_per_pax * requestedPaxPerRoom;
            console.log(`🍽️ MEAL ADDED: ${requestedPaxPerRoom} pax x ${vendorData.meal_price_per_pax} = ${mealCostPerRoom} SAR`);
        } else {
            appliedMeal = 'RO';
            mealCostPerRoom = 0;
        }
    }
    
    let appliedView = (childQuery.view || 'CITY VIEW').toUpperCase();
    let viewSurcharge = 0;
    
    if (vendorData.view_surcharges) {
        if (appliedView.includes('KAABA')) viewSurcharge = vendorData.view_surcharges.kaaba || 0;
        else if (appliedView.includes('HARAM')) viewSurcharge = vendorData.view_surcharges.haram || 0;
        else if (appliedView.includes('CITY')) viewSurcharge = vendorData.view_surcharges.city || 0;
    }

// ======================================================
    // 🛡️ TIER RETRIEVAL & MATH LOOP (FINAL STABLE FIX)
    // ======================================================
    const { getDatabase } = require('../database');
    const db = getDatabase();

    // 1. DYNAMIC ID DETECTION: Matches 'child_id' from your database.js fetcher
    const targetId = childQuery.child_id || childQuery.id || 792; 
    
    // 2. TRACE BACK: Manually JOIN tables to find the original client's JID
    let trace = db.prepare(`
        SELECT pq.remote_jid, cq.parent_id 
        FROM child_queries cq 
        JOIN parent_queries pq ON cq.parent_id = pq.id 
        WHERE cq.id = ?
    `).get(targetId);

    // 3. IDENTIFY CLIENT: Determine the correct JID for the groups table lookup
    const originalGroupJid = trace ? trace.remote_jid : (childQuery.client_group_id || updatedQuery.remote_jid);
    const parentId = trace ? trace.parent_id : childQuery.parent_id;

    // 4. FETCH PROFILE: Match JID to your 'groups' table using 'group_id'
    const groupInfo = db.prepare(`SELECT markup_tier, client_code FROM groups WHERE group_id = ?`).get(originalGroupJid);
    
    // 5. NORMALIZE: Force Uppercase to match the 'HIGH' rule card in your rule table
    const activeMarkupTier = groupInfo && groupInfo.markup_tier ? groupInfo.markup_tier.trim().toUpperCase() : 'DEFAULT';
    const clientRefCode = groupInfo ? groupInfo.client_code : 'REQ';

    console.log(`🔍 [TRACE] ChildID: ${targetId} | ParentID: ${parentId} | Client: ${originalGroupJid} | Tier: ${activeMarkupTier}`);
    let totalCostOneRoom = 0;
    let totalExtraBedCostAllNights = 0; 
    const breakdown = [];
    let currentDate = new Date(updatedQuery.check_in);
    const endDate = new Date(updatedQuery.check_out);

    while (currentDate < endDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const dayOfWeek = currentDate.getDay();
        const isWeekend = WEEKEND_DAYS.includes(dayOfWeek);
        const targetType = isWeekend ? 'WEEKEND' : 'WEEKDAY';

        let matchedRateObj = allRates.find(r => {
            if (!r.dates) return false;
            const parts = r.dates.split(' to ');
            if (parts.length !== 2) return false;
            // Exact date match logic
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
        
        const baseRate = matchedRateObj ? (matchedRateObj.rate || 0) : 0;
        const nightlyExtraBedPrice = matchedRateObj.extra_bed_rate || vendorData.extra_bed_price || 0;

        if (isLocalDB && extraBedsPerRoom > 0 && nightlyExtraBedPrice === 0) {
            console.log(`🚫 V2 REJECTED: Local DB quote needs ${extraBedsPerRoom} extra bed(s), but has NO extra bed price.`);
            return null; 
        }
        
        const currentExtraBedTotal = nightlyExtraBedPrice * extraBedsPerRoom;
        totalExtraBedCostAllNights += currentExtraBedTotal; 

        const nightlyRoomRate = baseRate + viewSurcharge + currentExtraBedTotal;
        const netDailyTotal = nightlyRoomRate + mealCostPerRoom;

        console.log(`🧮 MATH DEBUG for ${dateStr}: Base(${baseRate}) + EB(${currentExtraBedTotal}) + View(${viewSurcharge}) + Meal(${mealCostPerRoom}) = ${netDailyTotal} SAR`);
        
        // 🛡️ APPLY MARKUP USING TRACED DYNAMIC TIER
        const margin = getMarkup(activeMarkupTier, netDailyTotal);
        const finalSellingPrice = netDailyTotal + margin;

        totalCostOneRoom += finalSellingPrice;

        breakdown.push({
            date: dateStr,
            base_rate: baseRate,
            surcharges: viewSurcharge + currentExtraBedTotal,
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
            client_code: clientRefCode,
            markup_tier: activeMarkupTier 
        }
    };
}

module.exports = { calculateQuote };