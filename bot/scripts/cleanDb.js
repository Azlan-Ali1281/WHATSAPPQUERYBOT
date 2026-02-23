// scripts/cleanDb.js
const { db } = require('../src/database');

function cleanDatabase() {
    console.log("🧹 Starting Deep Database Cleanup...");

    // 1. Fetch every quote and its linked query data
    const rows = db.prepare(`
        SELECT 
            vq.id as quote_id,
            cq.hotel_name, 
            cq.check_in, 
            cq.check_out, 
            vq.full_json
        FROM vendor_quotes vq
        JOIN vendor_requests vr ON vq.request_id = vr.id
        JOIN child_queries cq ON vr.child_id = cq.id
    `).all();

    const toDelete = [];
    const stats = {
        missingData: 0,
        badName: 0,
        tooExpensive: 0,
        weekendCheaper: 0,
        totalDeleted: 0
    };

    // 🛡️ REGEX: \b means "Word Boundary". It ensures we delete "Any" or "Or" as whole words, 
    // but we don't accidentally delete "Zowar" or "Coral".
    const badNameRegex = /\bany\b|\/|\bor\b|clock tower/i;

    rows.forEach(row => {
        let shouldDelete = false;
        let data = {};

        try {
            data = JSON.parse(row.full_json);
        } catch (e) {
            data = {}; // If JSON is corrupted, it will be caught by the Missing Data rule
        }

        // 🧠 Extract the rates from the JSON
        let baseRate = 0;
        let weekdayRate = 0;
        let weekendRate = 0;

        if (data.split_rates && data.split_rates.length > 0) {
            baseRate = data.split_rates[0].rate || 0;
            const wd = data.split_rates.find(r => r.type && r.type.toUpperCase() === 'WEEKDAY');
            const we = data.split_rates.find(r => r.type && r.type.toUpperCase() === 'WEEKEND');
            if (wd) weekdayRate = wd.rate;
            if (we) weekendRate = we.rate;
        } else if (data.rate) {
            baseRate = data.rate;
        }

        // 🛑 RULE 1: Missing Dates, Missing Hotel, or Rate is 0
        if (!row.check_in || !row.check_out || !row.hotel_name || baseRate === 0) {
            stats.missingData++;
            shouldDelete = true;
        }
        // 🛑 RULE 2: Vague Hotel Names (Any, /, or, Clock Tower)
        else if (badNameRegex.test(row.hotel_name)) {
            stats.badName++;
            shouldDelete = true;
        }
        // 🛑 RULE 3: Base rate higher than 3500 SAR
        else if (baseRate > 3500) {
            stats.tooExpensive++;
            shouldDelete = true;
        }
        // 🛑 RULE 4: Weekend rate is bizarrely cheaper than Weekday rate
        else if (weekendRate > 0 && weekdayRate > 0 && weekendRate < weekdayRate) {
            stats.weekendCheaper++;
            shouldDelete = true;
        }

        if (shouldDelete) {
            toDelete.push(row.quote_id);
        }
    });

    // 2. Execute the Deletions
    if (toDelete.length > 0) {
        // We use a database transaction to safely process all deletions at once
        const deleteQuote = db.prepare('DELETE FROM vendor_quotes WHERE id = ?');
        
        db.transaction(() => {
            for (const id of toDelete) {
                deleteQuote.run(id);
            }
            
            // 🧹 THE ORPHAN CLEANUP: 
            // Now that the bad quotes are gone, we delete the useless queries left behind!
            db.prepare(`DELETE FROM vendor_requests WHERE id NOT IN (SELECT request_id FROM vendor_quotes)`).run();
            db.prepare(`DELETE FROM child_queries WHERE id NOT IN (SELECT child_id FROM vendor_requests)`).run();
            db.prepare(`DELETE FROM parent_queries WHERE id NOT IN (SELECT parent_id FROM child_queries)`).run();
        })();
        
        stats.totalDeleted = toDelete.length;
        console.log(`\n✅ Cleanup Complete! Nuked ${stats.totalDeleted} bad records.`);
        console.log(`📊 DELETION BREAKDOWN:`);
        console.log(` ➖ Missing Dates / 0 Rate: ${stats.missingData}`);
        console.log(` ➖ Vague/Bad Hotel Name:   ${stats.badName}`);
        console.log(` ➖ Unrealistic (>3500):    ${stats.tooExpensive}`);
        console.log(` ➖ Weekend < Weekday:      ${stats.weekendCheaper}\n`);
    } else {
        console.log("\n✨ Your database is already squeaky clean! No records matched the deletion criteria.\n");
    }
}

cleanDatabase();