// scripts/checkDb.js
const { db } = require('../src/database');

function checkDatabase() {
    console.log("\n📊 --- V3 DATABASE SUMMARY ---");

    try {
        // 1. Total Scrapped Queries (Parents)
        const parents = db.prepare("SELECT COUNT(*) as count FROM parent_queries").get();
        
        // 2. Total Specific Hotel/Date combinations (Children)
        const children = db.prepare("SELECT COUNT(*) as count FROM child_queries").get();
        
        // 3. Total Parsed JSON Quotes (The Gold!)
        const quotes = db.prepare("SELECT COUNT(*) as count FROM vendor_quotes").get();

        // 4. Breakdown by Hotel Name (Top 10)
        const hotelBreakdown = db.prepare(`
            SELECT vendor_hotel_name, COUNT(*) as count 
            FROM vendor_quotes 
            GROUP BY vendor_hotel_name 
            ORDER BY count DESC 
            LIMIT 10
        `).all();

        console.log(`📂 Total Original Messages Scrapped: ${parents.count}`);
        console.log(`🏨 Total Unique Hotel Queries:     ${children.count}`);
        console.log(`💰 Total JSON Rates Collected:     ${quotes.count}`);

        if (hotelBreakdown.length > 0) {
            console.log("\n🔝 TOP 10 MINED HOTELS:");
            console.table(hotelBreakdown);
        } else {
            console.log("\n⚠️ No rates found yet. Keep the miner running!");
        }

        // 5. Recent Entry Preview
        const lastQuote = db.prepare(`
            SELECT vendor_hotel_name, raw_reply_text 
            FROM vendor_quotes 
            ORDER BY id DESC LIMIT 1
        `).get();

        if (lastQuote) {
            console.log("\n✨ LATEST MINED RATE:");
            console.log(`Hotel: ${lastQuote.vendor_hotel_name}`);
            console.log(`Text:  ${lastQuote.raw_reply_text.substring(0, 60)}...`);
        }

    } catch (err) {
        console.error("❌ Error reading database:", err.message);
    }
    
    console.log("-------------------------------\n");
}

checkDatabase();