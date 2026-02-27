const { getDatabase } = require('../database');
const db = getDatabase();

/**
 * 🧮 DYNAMIC MARKUP CALCULATION
 * This is the ONLY function that should calculate profit.
 */
function getMarkup(markupTier, netDailyTotal) {
    try {
const tierSearch = (markupTier || 'DEFAULT').trim().toUpperCase();
const rule = db.prepare(`SELECT markup_amount FROM markup_rules WHERE UPPER(client_code) = ? AND ? >= min_price AND ? < max_price LIMIT 1`).get(tierSearch, netDailyTotal, netDailyTotal);

        if (rule) {
            console.log(`📈 [MARKUP] Found Rule for ${tierSearch}: +${rule.markup_amount} SAR`);
            return rule.markup_amount;
        }

        // Fallback logic
        const fallback = db.prepare(`
            SELECT markup_amount FROM markup_rules 
            WHERE client_code = 'DEFAULT' 
            AND ? >= min_price AND ? < max_price 
            LIMIT 1
        `).get(netDailyTotal, netDailyTotal);

        return fallback ? fallback.markup_amount : 20;
    } catch (e) {
        console.error("🚨 Markup Engine Error:", e.message);
        return 20; 
    }
}

// Support functions for WhatsApp commands (kept so bot doesn't crash)
function updateTiers(newTiers) { return; } 
function getCurrentTiers() { return []; }

module.exports = { getMarkup, updateTiers, getCurrentTiers };