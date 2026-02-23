// src/v2/markupEngine.js

// 🛡️ DEFAULT FALLBACK TIERS (Before you send a WhatsApp command)
let activeTiers = [
    { threshold: 500, margin: 20 },
    { threshold: 1000, margin: 40 },
    { threshold: Infinity, margin: 60 }
];

/**
 * 🧮 Calculates the profit markup based on the net room rate
 */
function getMarkup(clientCode, netDailyTotal) {
    // Note: If you have special logic for 'clientCode' (like VIPs), you can keep it here!
    
    // Find the first tier where the net cost is less than or equal to the threshold
    for (const tier of activeTiers) {
        if (netDailyTotal <= tier.threshold) {
            return tier.margin;
        }
    }
    
    // Safety fallback
    return activeTiers[activeTiers.length - 1].margin;
}

/**
 * 🔄 Updates the active tiers dynamically from WhatsApp
 */
function updateTiers(newTiers) {
    // Sort them from lowest threshold to highest to ensure the math always works
    activeTiers = newTiers.sort((a, b) => a.threshold - b.threshold);
}

/**
 * 📊 Returns the current rules for the WhatsApp confirmation message
 */
function getCurrentTiers() {
    return activeTiers;
}

module.exports = { getMarkup, updateTiers, getCurrentTiers };