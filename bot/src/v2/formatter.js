// src/v2/formatter.js

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

// 🛡️ The message constructor used when you type /send
function buildClientMessage(quote, modifier = 0) {
    const nights = quote.breakdown.length;
    const finalNightlyAvg = Math.round(quote.total_price / nights) + modifier;
    
    return `*${quote.hotel}*
${formatDateRange(quote.check_in, quote.check_out, quote.dateLabel)} (${nights} Nights)
${quote.rooms} Rooms (${quote.room_type})
${quote.applied_meal} / ${quote.applied_view}

*${finalNightlyAvg} SAR* (Avg/Night per room)

*Subject To Availability*`;
}

// 🛡️ Added requestId to track the message
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
    if (eb > 0) addOnsText += `   + Extra Bed (${ebQty}): ${eb} / night\n`;

    // Calculate Averages
    const totalNet = breakdown.reduce((sum, day) => sum + day.net_daily, 0);
    const avgNetNightly = Math.round(totalNet / nights);
    const finalNightlyAvg = Math.round(total_price / nights);
    const grandTotal = total_price * rooms;

    return `🧪 *V2 SHADOW MODE REPORT*
-------------------------------
📝 *Vendor Said:*
"${vendor_text}"

🤖 *AI Understanding:*
• Hotel: ${hotel}
• Meal: ${applied_meal}
• View: ${applied_view}

🧮 *Math Logic (Per Room):*
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
${rooms} Rooms (${room_type})
${applied_meal} / ${applied_view}

*${finalNightlyAvg} SAR* (Avg/Night per room)

*Subject To Availability*`;
}

module.exports = { formatForOwner, buildClientMessage };