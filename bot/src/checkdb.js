/**
 * DATABASE INSPECTOR
 * Run this to verify your SQLite data before launching the Express Dashboard.
 */

const { db } = require('./database'); 

console.log("\n🔍 --- DATABASE INSPECTION REPORT --- 🔍");
console.log("==========================================");
console.log("📊 --- DATABASE DIAGNOSTICS ---");

const tables = ['parent_queries', 'child_queries', 'groups'];
tables.forEach(table => {
    try {
        const info = db.prepare(`PRAGMA table_info(${table})`).all();
        console.log(`\n📂 Table: ${table}`);
        console.table(info.map(c => ({ Column: c.name, Type: c.type })));
    } catch (e) { console.log(`❌ Table ${table} not found.`); }
});

// Check if your "HIGH" rule exists
const rules = db.prepare("SELECT * FROM markup_rules WHERE UPPER(client_code) = 'HIGH'").all();
console.log("\n💰 HIGH Rules Found:", rules.length);
console.table(rules);

try {
    // 1. Check Clients
    console.log("\n👥 [CLIENTS]");
    const clients = db.prepare("SELECT name, client_code, limit_tier, group_id FROM groups WHERE role = 'CLIENT'").all();
    if (clients.length > 0) {
        console.table(clients);
    } else {
        console.log("   (No clients found)");
    }

    // 2. Check Vendors & Hotel Maps
    console.log("\n🏨 [VENDORS]");
    const vendors = db.prepare("SELECT name, client_code, handled_hotels FROM groups WHERE role = 'VENDOR'").all();
    if (vendors.length > 0) {
        vendors.forEach(v => {
            let hotels = "NONE";
            try {
                const parsed = JSON.parse(v.handled_hotels);
                hotels = parsed.includes("ALL") ? "✨ ALL (Catch-All)" : parsed.join(", ");
            } catch(e) {
                hotels = "⚠️ Error parsing hotels";
            }
            // Pretty-printing the vendor list
            console.log(`- ${v.name.padEnd(25)} | Code: ${v.client_code.padEnd(5)} | Map: ${hotels}`);
        });
    } else {
        console.log("   (No vendors found)");
    }

    // 3. Check Limit Tiers
    console.log("\n💎 [LIMIT TIERS]");
    const tiers = db.prepare("SELECT * FROM limit_tiers").all();
    if (tiers.length > 0) {
        console.table(tiers);
    } else {
        console.log("   (No tiers found)");
    }

    // 4. Check Employees
    console.log("\n👨‍💼 [EMPLOYEES]");
    const employees = db.prepare("SELECT name, jid FROM employees").all();
    if (employees.length > 0) {
        console.table(employees);
    } else {
        console.log("   (No employees found)");
    }

} catch (error) {
    console.error("\n❌ DATABASE ERROR:", error.message);
} finally {
    console.log("\n==========================================");
    console.log("✅ Inspection Complete.");
    
    // We close the connection here because this is a standalone script
    db.close();
}