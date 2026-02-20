// src/v2/markupEngine.js
const { getDatabase } = require('../database');

/**
 * 💰 THE PROFIT ENGINE
 * Applied to the total net nightly rate (Base + View + Extra Bed + Meal)
 */
function getMarkup(clientCode = 'DEFAULT', netNightlyPrice) {
    const db = getDatabase();
    
    // We fetch the rule that fits the price tier
    const rule = db.prepare(`
        SELECT * FROM markup_rules 
        WHERE client_code = ?
        AND ? >= min_price AND ? < max_price
        LIMIT 1
    `).get(clientCode, netNightlyPrice, netNightlyPrice);

    if (!rule) {
        // Fallback safety: if DB lookup fails, apply the logic manually
        return netNightlyPrice >= 1000 ? 40 : 20;
    }

    if (rule.markup_type === 'PERCENT') {
        return Math.round(netNightlyPrice * (rule.markup_amount / 100));
    }
    
    return rule.markup_amount;
}

module.exports = { getMarkup };