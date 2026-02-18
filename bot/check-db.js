const Database = require('better-sqlite3');
const db = new Database('bot.db'); 

console.log("\n========= 1. PARENT QUERIES (Client Msg) =========");
try {
    const parents = db.prepare('SELECT * FROM parent_queries').all();
    console.table(parents);
} catch (e) { console.log("Empty/Missing"); }

console.log("\n========= 2. CHILD QUERIES (Parsed Hotel) =========");
try {
    const children = db.prepare('SELECT * FROM child_queries').all();
    console.table(children);
} catch (e) { console.log("Empty/Missing"); }

console.log("\n========= 3. VENDOR REQUESTS (Sent Msgs) =========");
try {
    const requests = db.prepare('SELECT * FROM vendor_requests').all();
    console.table(requests);
} catch (e) { console.log("Empty/Missing"); }

// 👇 NEW SECTION: THIS SHOWS THE REPLIES
console.log("\n========= 4. VENDOR QUOTES (Replies Received) =========");
try {
    const quotes = db.prepare('SELECT * FROM vendor_quotes').all();
    console.table(quotes);
} catch (e) { console.log("Empty/Missing"); }

console.log("\n✅ Database check complete.");