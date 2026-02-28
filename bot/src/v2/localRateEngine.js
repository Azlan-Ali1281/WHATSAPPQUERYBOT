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
 * 🔍 Smart Local Rate Engine v3
 * Priority 1: Find best single vendor reply covering full range.
 * Priority 2: Stitch multiple replies to cover gaps night-by-night.
 */
async function processLocalRates(childQuery, sock, quoteData) {
    const requestedHotel = childQuery.hotel;
    const qStart = childQuery.check_in;
    const qEnd = childQuery.check_out;

    // 🛡️ Select quotes from the last 10 days for deeper archive searching
    const sql = `
        SELECT vq.full_json, vq.raw_reply_text AS vendor_text, g.name as vendor_name
        FROM vendor_quotes vq
        JOIN vendor_requests vr ON vq.request_id = vr.id
        JOIN groups g ON vr.vendor_group_id = g.group_id
        JOIN child_queries cq ON vr.child_id = cq.id
        WHERE cq.hotel_name = ? 
        AND vq.full_json IS NOT NULL
        AND vq.created_at >= datetime('now', '-14 days')
        ORDER BY vq.id DESC LIMIT 50
    `;

    try {
        const rows = db.prepare(sql).all(requestedHotel);
        if (!rows || rows.length === 0) {
            console.log(`📭 LOCAL DB: No recent past quotes found for ${requestedHotel}.`);
            return null; 
        }

        // 🛡️ Sanitize inputs
        childQuery.rooms = parseInt(childQuery.rooms) || 1;
        childQuery.persons = parseInt(childQuery.persons) || (childQuery.rooms * 2);

        // --- PHASE 1: TRY SINGLE SOURCE (Priority) ---
        console.log(`📦 LOCAL DB: Checking for single-source match for ${requestedHotel}...`);
        const singleSourceQuotes = [];

        for (const row of rows) {
            try {
                const parsedDB = JSON.parse(row.full_json);
                const preParsedData = parsedDB.raw_vendor_data ? parsedDB.raw_vendor_data : parsedDB;
                
                // Gate 2 in calculator will reject these if dates don't cover full stay
                const quote = await calculateQuote(childQuery, row.vendor_text, preParsedData);
                if (quote) {
                    quote.vendors_involved = [row.vendor_name]; // Track single vendor
                    singleSourceQuotes.push(quote);
                }
            } catch (e) {}
        }

        // If we found full matches and are NOT forced to stitch (like in archive testing), return them
        if (singleSourceQuotes.length > 0 && !childQuery.force_stitch) {
            console.log(`✅ SINGLE SOURCE: Found ${singleSourceQuotes.length} valid full-stay quotes.`);
            if (childQuery.is_archive_test) return singleSourceQuotes;
            return deliverBestQuotes(singleSourceQuotes, sock, quoteData);
        }

        // --- PHASE 2: STITCHING FALLBACK (If Phase 1 fails or stitch is forced) ---
        console.log(`🧵 STITCHER: Attempting to combine nights for ${requestedHotel}...`);
        
        const requestedNights = [];
        let d = new Date(qStart);
        while (d < new Date(qEnd)) {
            requestedNights.push(d.toISOString().split('T')[0]);
            d.setDate(d.getDate() + 1);
        }

        const allPotentialRates = [];
        rows.forEach(row => {
            try {
                const data = JSON.parse(row.full_json).raw_vendor_data || JSON.parse(row.full_json);
                const rates = (data.split_rates || data.rates || []).map(r => ({ 
                    ...r, 
                    _master: data,
                    _vName: row.vendor_name 
                }));
                allPotentialRates.push(...rates);
            } catch (e) {}
        });

        const stitchedNights = [];
        const vendorsUsed = new Set();

        for (const night of requestedNights) {
            const candidates = allPotentialRates.filter(r => {
                if (!r.dates || !r.dates.includes(' to ')) return false;
                const [s, e] = r.dates.split(' to ');
                return night >= s && night < e;
            });

            if (candidates.length === 0) {
                console.log(`📭 STITCHER: Missing rate for ${night}. Giving up.`);
                return null;
            }

            // Pick the cheapest rate available for this specific night
            candidates.sort((a, b) => a.rate - b.rate);
            stitchedNights.push({ date: night, bestRate: candidates[0] });
            vendorsUsed.add(candidates[0]._vName);
        }

        // Build a composite vendor JSON
        const masterTemplate = stitchedNights[0].bestRate._master;
        const compositeData = {
            ...masterTemplate,
            is_stitched: true, // 🛡️ Hall pass for Gate 2
            split_rates: stitchedNights.map(sn => ({
                dates: `${sn.date} to ${new Date(new Date(sn.date).getTime() + 86400000).toISOString().split('T')[0]}`,
                rate: sn.bestRate.rate,
                type: sn.bestRate.type,
                extra_bed_rate: sn.bestRate.extra_bed_rate || masterTemplate.extra_bed_price || 0
            }))
        };

        const stitchedQuote = await calculateQuote(childQuery, "Stitched Composite Reply", compositeData);
        if (stitchedQuote) {
            stitchedQuote.vendors_involved = Array.from(vendorsUsed); // Show multiple names
            console.log(`⚡ STITCHED SUCCESS: Created composite quote covering full range.`);
            if (childQuery.is_archive_test) return [stitchedQuote];
            return deliverBestQuotes([stitchedQuote], sock, quoteData);
        }

    } catch (err) {
        console.error("❌ Local Rate Engine Error:", err.message);
    }
    return null;
}

/**
 * 📤 Formats, filters value, and sends the winners
 */
async function deliverBestQuotes(quotes, sock, quoteData) {
    // Sort from Cheapest to Most Expensive
    quotes.sort((a, b) => a.total_price - b.total_price);
    
    const winners = [];
    for (const q of quotes) {
        const mScore = getMealScore(q.applied_meal);
        const vScore = getViewScore(q.applied_view);
        
        // Pareto Filter: Only keep if it's better meal/view than someone already in the winner list
        let redundant = winners.some(w => getMealScore(w.applied_meal) >= mScore && getViewScore(w.applied_view) >= vScore);
        if (!redundant) winners.push(q);
    }
    if (!sock) return winners;


        for (const best of winners) {
            const finalMsg = buildClientMessage(best, 0); 
            await sock.sendMessage(quoteData.client_group_id, { text: finalMsg }, { 
                quoted: {
                    key: { 
                        remoteJid: quoteData.client_group_id, 
                        fromMe: false, 
                        id: quoteData.client_msg_id, 
                        participant: quoteData.client_participant 
                    },
                    message: { conversation: quoteData.original_text || "Local Rate Search" }
                }
            });
        
    }
    return true;
}

module.exports = { processLocalRates };