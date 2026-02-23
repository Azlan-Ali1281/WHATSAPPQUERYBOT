// scripts/reparse.js
const { db } = require('../src/database');
const { parseVendorMessageWithAI } = require('../src/v2/aiVendorParser');

async function fixDatabase() {
    console.log("🛠️ Starting Database Reparse...");
    
    // 1. Get all quotes that need better JSON
    const quotes = db.prepare("SELECT id, raw_reply_text FROM vendor_quotes WHERE raw_reply_text IS NOT NULL").all();
    console.log(`Found ${quotes.length} quotes to process.`);

    for (const quote of quotes) {
        console.log(`Processing ID ${quote.id}...`);
        
        try {
            // We pass a dummy query just to give the AI context, 
            // but we tell it to extract the GENERAL rates.
            const parsed = await parseVendorMessageWithAI(quote.raw_reply_text, {
                hotel: "Unknown",
                check_in: "2026-01-01",
                check_out: "2026-12-31" 
            });

            if (parsed) {
                db.prepare("UPDATE vendor_quotes SET full_json = ? WHERE id = ?")
                  .run(JSON.stringify(parsed), quote.id);
                console.log(`✅ Updated ID ${quote.id}`);
            }
        } catch (e) {
            console.error(`❌ Failed ID ${quote.id}:`, e.message);
        }
        
        // Wait 1 second to avoid hitting AI rate limits
        await new Promise(r => setTimeout(r, 1000));
    }
    
    console.log("✨ All done! Your Local Engine will now be instant.");
}

fixDatabase();