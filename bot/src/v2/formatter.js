// src/v2/formatter.js

/**
 * 📅 Formats the date range for the final message
 */
function formatDateRange(checkIn, checkOut, label = null) {
    if (label) return label; 
    try {
        const d1 = new Date(checkIn);
        const d2 = new Date(checkOut);
        const opts = { day: 'numeric', month: 'short' };
        return `${d1.toLocaleDateString('en-GB', opts)} - ${d2.toLocaleDateString('en-GB', opts)}`;
    } catch (e) {
        return `${checkIn} to ${checkOut}`;
    }
}

/**
 * 🧠 Determines exactly what Room Type string to show the client
 */
function getRoomDisplay(quote) {
    let roomDisplay = (quote.room_type || 'Room').toUpperCase();
    
    // If the vendor offered a different room natively (no extra beds needed)
    // E.g., Client asked for TRIPLE, Vendor offered a SUITE. -> Show SUITE.
    const ebQty = quote.cost_breakdown?.eb_qty || 0;
    if (ebQty === 0 && quote.offered_room_type && quote.offered_room_type.trim() !== "") {
        roomDisplay = quote.offered_room_type.toUpperCase();
    }
    
    return roomDisplay;
}

/**
 * 🛡️ The message constructor used when the AutoQuoter sends to the client
 * Optimized for maximum simplicity.
 */
/**
 * 🛡️ The message constructor used when the AutoQuoter sends to the client
 * Optimized for maximum simplicity.
 */
/**
 * 🛡️ The message constructor used when the AutoQuoter sends to the client
 * Optimized for maximum simplicity.
 */
function buildClientMessage(quote, modifier = 0) {
    // Failsafe in case of old database rows
    const nights = quote.breakdown ? quote.breakdown.length : 1;
    const finalNightlyAvg = Math.round(quote.total_price / nights) + modifier;
    
    const roomDisplay = getRoomDisplay(quote);
    
    // 🛡️ THE FIX: If revised, show *Revised*. Otherwise, absolutely no header.
    const topHeader = modifier !== 0 ? `*Revised*\n\n` : ``;
    
    return `${topHeader}*${quote.hotel}*
${formatDateRange(quote.check_in, quote.check_out, quote.dateLabel)} (${nights} Nights)
${roomDisplay}
${quote.applied_meal} / ${quote.applied_view}

*${finalNightlyAvg} SAR* (Avg/Night per room)

*Subject To Availability*`;
}
/**
 * 🛡️ The detailed report sent to the Owner group for monitoring
 */
function formatForOwner(quote, requestId) {
    if (!quote || !quote.breakdown) return "⚠️ Error: Invalid Quote Data";

    const { 
        hotel, check_in, check_out, rooms, room_type,
        applied_meal, applied_view, breakdown, total_price, vendor_text,
        cost_breakdown, dateLabel
    } = quote;

    const nights = breakdown.length;
    if (nights === 0) return "⚠️ Error: 0 nights calculated.";

    // 1. Group Base Rates
    const rateGroups = {};
    breakdown.forEach(day => {
        const rate = day.base_rate;
        if (!rateGroups[rate]) rateGroups[rate] = 0;
        rateGroups[rate]++;
    });

    let rateBreakdown = Object.entries(rateGroups).map(([rate, count]) => {
        return `   ${count}x Nights @ ${rate} = ${rate * count}`;
    }).join('\n');

    // 2. Add-ons & Margin Breakdown
    const cb = cost_breakdown || {};
    const meal = cb.meal_daily_per_room || 0;
    const view = cb.view_daily_per_room || 0;
    const eb = cb.eb_daily_per_room || 0;
    const ebQty = cb.eb_qty || 0;
    const totalMargin = cb.margin_total || 0;
    
    let addOnsText = "";
    if (meal > 0) addOnsText += `   + Meal: ${meal} / night\n`;
    if (view > 0) addOnsText += `   + View: ${view} / night\n`;
    if (eb > 0) addOnsText += `   + Extra Bed (${ebQty} pcs): ${eb} / night\n`;

    // Calculate Averages
    const totalNet = breakdown.reduce((sum, day) => sum + day.net_daily, 0);
    const avgNetNightly = Math.round(totalNet / nights);
    const finalNightlyAvg = Math.round(total_price / nights);
    const grandTotal = total_price * rooms;

    const roomDisplay = getRoomDisplay(quote);

    // 🛡️ Owner Note: Adds a small text next to the room logic so YOU know how it was calculated
    let ownerMathNote = "";
    if (ebQty > 0) {
        ownerMathNote = ` (Calculated as Base + ${ebQty} Ex. Bed)`;
    } else if (quote.offered_room_type && quote.offered_room_type.toUpperCase() !== room_type.toUpperCase()) {
        ownerMathNote = ` (Vendor offered alternative: ${quote.offered_room_type.toUpperCase()})`;
    }

    return `🧪 *V2 SHADOW MODE REPORT*
-------------------------------
📝 *Vendor Said:*
"${vendor_text}"

🤖 *AI Understanding:*
• Hotel: ${hotel}
• Meal: ${applied_meal}
• View: ${applied_view}

🧮 *Math Logic (Per Room):*
Room Request: ${room_type.toUpperCase()}${ownerMathNote}
${rateBreakdown}
${addOnsText}   ----------------
   Avg Net Nightly : ${avgNetNightly} SAR
   💰 Markup Applied : +${Math.round(totalMargin / nights)} / night
   ----------------
   = Selling Total : ${finalNightlyAvg} SAR
   x ${nights} Nights
   x ${rooms} Rooms
   
💵 *Total Profit:* +${totalMargin * rooms} SAR
💰 *Final Output:* *${grandTotal} SAR*
🏷️ *Ref:* RQ-${requestId}
-------------------------------
👇 *Reply with /send to forward to client:*

*${hotel}*
${formatDateRange(check_in, check_out, dateLabel)} (${nights} Nights)
${roomDisplay}
${applied_meal} / ${applied_view}

*${finalNightlyAvg} SAR* (Avg/Night per room)

*Subject To Availability*`;
}

module.exports = { formatForOwner, buildClientMessage };