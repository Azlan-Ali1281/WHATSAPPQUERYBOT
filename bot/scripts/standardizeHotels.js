// scripts/manualFixes.js
const { db } = require('../src/database');

function manualFixes() {
    console.log("🛠️ Starting Manual Database Fixes...");

    // --- 1. TARGETED DELETIONS ---
    // We use lowercase keywords so it catches "Clocktower", "CLOCKTOWER", etc.
    const badKeywords = ['ladies gate', 'mazkaziya', 'clocktower'];
    const quotesToDelete = [];
    
    // Find all quotes that contain these garbage names
    const rows = db.prepare(`
        SELECT vq.id, cq.hotel_name
        FROM vendor_quotes vq
        JOIN vendor_requests vr ON vq.request_id = vr.id
        JOIN child_queries cq ON vr.child_id = cq.id
    `).all();

    rows.forEach(row => {
        const name = row.hotel_name.toLowerCase();
        // If the hotel name contains any of the bad keywords, flag it for deletion
        if (badKeywords.some(keyword => name.includes(keyword))) {
            quotesToDelete.push(row.id);
        }
    });

    if (quotesToDelete.length > 0) {
        console.log(`\n🗑️ Deleting ${quotesToDelete.length} quotes with bad hotel names...`);
        const deleteQuote = db.prepare('DELETE FROM vendor_quotes WHERE id = ?');
        
        // Use a transaction to safely delete the quotes and clean up the orphaned queries
        db.transaction(() => {
            for (const id of quotesToDelete) {
                deleteQuote.run(id);
            }
            // Clean up the orphans left behind
            db.prepare(`DELETE FROM vendor_requests WHERE id NOT IN (SELECT request_id FROM vendor_quotes)`).run();
            db.prepare(`DELETE FROM child_queries WHERE id NOT IN (SELECT child_id FROM vendor_requests)`).run();
            db.prepare(`DELETE FROM parent_queries WHERE id NOT IN (SELECT parent_id FROM child_queries)`).run();
        })();
        console.log("✅ Deletions complete.");
    } else {
        console.log("\n➖ No bad names found to delete.");
    }

    

    // --- 2. TARGETED CONVERSIONS ---
    const updates = [
        { old: 'artal al munawara', new: 'Artal International' },
        { old: 'tree', new: 'DoubleTree by Hilton Makkah' }
    ];

    // We use LOWER() so it matches "Tree", "tree", "TREE" perfectly
    const updateChild = db.prepare("UPDATE child_queries SET hotel_name = ? WHERE LOWER(hotel_name) = ?");
    const updateVendor = db.prepare("UPDATE vendor_quotes SET vendor_hotel_name = ? WHERE LOWER(vendor_hotel_name) = ?");

    console.log("\n🔄 Applying manual name conversions...");
    db.transaction(() => {
        for (const u of updates) {
            // Update both the query record and the vendor quote record
            const childChanges = updateChild.run(u.new, u.old.toLowerCase()).changes;
            const vendorChanges = updateVendor.run(u.new, u.old.toLowerCase()).changes;
            
            if (childChanges > 0 || vendorChanges > 0) {
                console.log(`   ✅ Converted: "${u.old}" ➡️ "${u.new}" (Updated ${childChanges} queries)`);
            } else {
                console.log(`   ➖ Not found in database: "${u.old}"`);
            }
        }
    })();

    console.log("\n🎉 All manual fixes applied successfully!");
}

manualFixes();