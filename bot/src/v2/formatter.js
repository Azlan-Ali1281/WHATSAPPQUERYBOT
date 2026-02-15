// src/v2/formatter.js

function formatForOwner(quote) {
  if (!quote || !quote.breakdown || quote.breakdown.length === 0) {
      return `⚠️ *V2 ERROR REPORT*
-------------------------------
Vendor Text: "${quote?.vendor_text || 'Unknown'}"
❌ Error: Calculator returned no data.`;
  }

  // 1. Format Dates
  const d1 = new Date(quote.check_in).toLocaleDateString('en-GB', {day:'numeric', month:'short'});
  const d2 = new Date(quote.check_out).toLocaleDateString('en-GB', {day:'numeric', month:'short'});
  const nights = quote.breakdown.length;

  // 2. SMART MATH PROOF 🧠
  // Detect if rates vary across nights
  const uniqueRates = [...new Set(quote.breakdown.map(b => b.final_daily))];
  
  let mathExplanation = '';
  
  if (uniqueRates.length === 1) {
      // SIMPLE CASE: Rate is same every night
      const sample = quote.breakdown[0];
      mathExplanation = `
   Base Rate:      ${sample.base_rate}
   + Surcharges:   ${sample.surcharges} (View/Extras)
   + Meal Cost:    ${sample.meal_cost}
   ----------------
   = Nightly:      ${sample.final_daily} x ${quote.rooms} Rooms
      `;
  } else {
      // SPLIT CASE: Rate changes! Show the split.
      // Group by rate (e.g., "5 Nights @ 485, 3 Nights @ 585")
      let currentRate = -1;
      let count = 0;
      let groups = [];
      
      quote.breakdown.forEach((b, index) => {
          if (b.final_daily !== currentRate) {
              if (count > 0) groups.push(`${count} Nights @ ${currentRate}`);
              currentRate = b.final_daily;
              count = 1;
          } else {
              count++;
          }
          // Handle last item
          if (index === quote.breakdown.length - 1) {
              groups.push(`${count} Nights @ ${currentRate}`);
          }
      });
      
      mathExplanation = `
   ⚠️ **SPLIT RATES DETECTED:**
   ${groups.join('\n   ')}
   
   (Includes Surcharges & Meals)
      `;
  }

  // 3. Construct the Owner Report
  return `🧪 *V2 SHADOW MODE REPORT*
-------------------------------
📝 *Vendor Said:*
"${quote.vendor_text}"

🤖 *AI Understanding:*
• Meal: ${quote.applied_meal}
• View: ${quote.applied_view}
• Flat Rate? ${quote.calculation_debug?.is_flat ? 'YES' : 'NO'}
• Extra Beds: ${quote.calculation_debug?.extra_beds_used || 0} per room

🧮 *Math Logic:*
${mathExplanation}

💰 *Final Output:*
*${quote.total_price} SAR* (For ${nights} Nights)
-------------------------------
👇 *Draft Message (Not Sent to Client):*

*${quote.hotel}*
${d1} - ${d2} (${nights} Nights)
${quote.rooms} Rooms (${quote.room_type})
${quote.applied_meal} / ${quote.applied_view}

*${Math.round(quote.total_price / nights)} SAR* (Avg/Night)
*${quote.total_price} SAR* (Total)
-------------------------------`;
}

module.exports = { formatForOwner };