const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../src/database'); 

function runMigration() {
    console.log("🚀 Starting V1 Static Rates Migration...");
    
    const db = getDatabase();
    
    // Path to your existing JSON file (assumes it's in the root folder or src folder)
    const jsonPathRoot = path.join(__dirname, '../savedRates.json');
    const jsonPathSrc = path.join(__dirname, 'savedRates.json');
    
    let jsonPath = fs.existsSync(jsonPathRoot) ? jsonPathRoot : null;
    if (!jsonPath) jsonPath = fs.existsSync(jsonPathSrc) ? jsonPathSrc : null;

    if (!jsonPath) {
        console.error("❌ Could not find savedRates.json in root or src folder!");
        return;
    }

    const rawData = fs.readFileSync(jsonPath, 'utf8');
    const hotels = JSON.parse(rawData);

    console.log(`📦 Found ${hotels.length} hotels in JSON. Injecting into database...`);

    const insertHotel = db.prepare(`
        INSERT OR REPLACE INTO static_hotels (
            hotel_id, hotel_name, aliases, 
            is_room_rate_flat, flat_till_pax, max_pax, 
            meal_included, included_meal_type, 
            is_weekend_flat, default_extra_bed_rate, 
            view_surcharges, meal_surcharges
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertSeason = db.prepare(`
        INSERT INTO static_seasons (
            hotel_id, description, start_date, end_date, 
            weekday_sd_rate, weekday_eb_rate, 
            weekend_sd_rate, weekend_eb_rate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const clearSeasons = db.prepare("DELETE FROM static_seasons WHERE hotel_id = ?");

    // Run everything inside a fast transaction
    const transaction = db.transaction(() => {
        for (const h of hotels) {
            const rules = h.rate_rules || {};
            const surcharges = rules.surcharges || { views: {}, meals: {} };

            // 1. Insert Hotel Core Rules
            insertHotel.run(
                h.id,
                h.hotel_info.name,
                JSON.stringify(h.hotel_info.aliases || []),
                
                rules.is_room_rate_flat ? 1 : 0,
                rules.flat_till_pax || 2,
                rules.max_pax || 4,
                
                rules.meal_included ? 1 : 0,
                rules.included_meal_type || 'BB',
                
                rules.is_weekend_flat ? 1 : 0,
                rules.default_extra_bed_rate || 0,
                
                JSON.stringify(surcharges.views || {}),
                JSON.stringify(surcharges.meals || {})
            );

            // 2. Clear old seasons for this hotel (prevents duplicates if run twice)
            clearSeasons.run(h.id);

            // 3. Insert Seasons
            const seasons = h.seasons || [];
            for (const s of seasons) {
                insertSeason.run(
                    h.id,
                    s.description || 'Standard Season',
                    s.start,
                    s.end,
                    s.rates?.weekday?.single_double || 0,
                    s.rates?.weekday?.extra_bed || rules.default_extra_bed_rate || 0,
                    s.rates?.weekend?.single_double || 0,
                    s.rates?.weekend?.extra_bed || rules.default_extra_bed_rate || 0
                );
            }
            console.log(`✅ Migrated: ${h.hotel_info.name} (${seasons.length} seasons)`);
        }
    });

    try {
        transaction();
        console.log("\n🎉 MIGRATION COMPLETE! All static rates are now in the SQLite database.");
        console.log("You can now safely rename or delete savedRates.json.");
    } catch (e) {
        console.error("❌ Migration failed:", e);
    }
}

// Execute the migration
runMigration();