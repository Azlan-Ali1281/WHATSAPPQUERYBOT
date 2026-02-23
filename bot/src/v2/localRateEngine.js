// src/v2/localRateEngine.js
const { db } = require('../database'); 
const { calculateQuote } = require('./calculator');
const { buildClientMessage } = require('./formatter');

// 🛡️ Value Scoring System (Apples-to-Apples)
function getMealScore(meal) {
    const m = (meal || '').toUpperCase();
    if (m.includes('FB')) return 3;
    if (m.includes('HB')) return 2;
    if (m.includes('BB')) return 1;
    return 0;
}

function getViewScore(view) {
    const v = (view || '').toUpperCase();
    if (v.includes('KAABA')) return 2;
    if (v.includes('HARAM')) return 1;
    return 0; // City View or unknown
}

/**
 * 🔍 Searches the EXISTING database for past vendor quotes (Synchronous SQLite)
 */
async function processLocalRates(childQuery, sock, quoteData) {
    const requestedHotel = childQuery.hotel;

    // 🛡️ THE FIX: Select the PRE-PARSED JSON instead of the raw text!
    const sql = `
        SELECT vq.full_json, vq.raw_reply_text AS vendor_text 
        FROM vendor_quotes vq
        JOIN vendor_requests vr ON vq.request_id = vr.id
        JOIN child_queries cq ON vr.child_id = cq.id
        WHERE cq.hotel_name = ? 
        AND vq.full_json IS NOT NULL
        AND vq.created_at >= datetime('now', '-2 days')
        ORDER BY vq.id DESC 
        LIMIT 20
    `;

    try {
        const stmt = db.prepare(sql);
        const rows = stmt.all(requestedHotel);

        if (!rows || rows.length === 0) {
            console.log(`📭 LOCAL DB: No recent past quotes found for ${requestedHotel}.`);
            return false; 
        }

        console.log(`📦 LOCAL DB: Found ${rows.length} past quotes for ${requestedHotel}. Checking dates instantly...`);
        
        // 🛡️ THE FIX: Sanitize the integers BEFORE passing to the calculator!
        // If these are strings ("3") or undefined, JS math fails silently.
        childQuery.rooms = parseInt(childQuery.rooms) || 1;
        
        // Default to 2 pax per room if not explicitly stated
        childQuery.persons = parseInt(childQuery.persons) || (childQuery.rooms * 2);

        console.log(`🧮 CLIENT NEEDS: ${childQuery.rooms} Room(s) | ${childQuery.persons} Pax`);

        const calculatedQuotes = [];

        // 1. Run the past vendor JSONs through the calculator with the NEW dates
// 1. Run the past vendor JSONs through the calculator with the NEW dates
        for (const row of rows) {
            try {
                const parsedDB = JSON.parse(row.full_json);
                
                // 🛡️ THE FIX: Support both our new full-quote format AND the old raw format!
                const preParsedData = parsedDB.raw_vendor_data ? parsedDB.raw_vendor_data : parsedDB;
                
                // 🛠️ EXTRA BED DEBUGGER
                // Look into the JSON to see what the vendor considers "Base Capacity"
                const baseCap = parseInt(preParsedData.quoted_base_capacity) || 2;
                const totalBaseCap = baseCap * childQuery.rooms;
                const extraBedsNeeded = Math.max(0, childQuery.persons - totalBaseCap);
                
                if (extraBedsNeeded > 0 && preParsedData.extra_bed_price) {
                    console.log(`   🛏️ DB Quote has Extra Bed @ ${preParsedData.extra_bed_price} SAR. Calculator will apply ${extraBedsNeeded} extra bed(s).`);
                }

                // 🛡️ Pass the preParsedData as the 3rd argument to skip AI
                const quote = await calculateQuote(childQuery, row.vendor_text, preParsedData);
                
                if (quote) {
                    calculatedQuotes.push(quote);
                }
            } catch (e) {
                // Ignore parsing errors on corrupted database rows
            }
        }

        if (calculatedQuotes.length === 0) {
            console.log(`📭 LOCAL DB: Past quotes found, but none covered the dates ${childQuery.check_in} to ${childQuery.check_out}.`);
            return false;
        }

        // 2. Sort from Lowest to Highest Price
        calculatedQuotes.sort((a, b) => a.total_price - b.total_price);
        
        // 3. Pareto Value Comparison (Find the absolute best deals)
        const bestValueQuotes = [];
        for (const q of calculatedQuotes) {
            const mScore = getMealScore(q.applied_meal);
            const vScore = getViewScore(q.applied_view);
            let isUseless = false;

            for (const winner of bestValueQuotes) {
                const wMeal = getMealScore(winner.applied_meal);
                const wView = getViewScore(winner.applied_view);
                
                if (wMeal >= mScore && wView >= vScore) {
                    isUseless = true;
                    break;
                }
            }

            if (!isUseless) bestValueQuotes.push(q);
        }

        // 4. Send the Winners Instantly!
        for (const best of bestValueQuotes) {
            const finalMsg = buildClientMessage(best, 0); 
            
            await sock.sendMessage(quoteData.client_group_id, { 
                text: finalMsg 
            }, { 
                quoted: {
                    key: {
                        remoteJid: quoteData.client_group_id,
                        fromMe: false,                               
                        id: quoteData.client_msg_id,
                        participant: quoteData.client_participant    
                    },
                    message: { conversation: quoteData.original_text || "Original Query" }
                }
            });
            console.log(`⚡ INSTANT SEND: Delivered local rate for ${requestedHotel} @ ${best.total_price} SAR`);
        }

        return true; 
        
    } catch (err) {
        console.error("❌ Database Error in localRateEngine:", err.message);
        return false; 
    }
}

module.exports = { processLocalRates };