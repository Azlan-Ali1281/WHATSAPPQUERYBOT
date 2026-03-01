const Database = require('better-sqlite3');
const path = require('path');

// 1. CONNECT TO DATABASE
const db = new Database(path.join(__dirname, '../bot.db'), { verbose: null });

// ======================================================
// 2. INITIALIZE TABLES (IMMEDIATELY)
// ======================================================
db.exec(`
    CREATE TABLE IF NOT EXISTS parent_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE,
        remote_jid TEXT,
        participant TEXT,
        original_text TEXT,
        status TEXT DEFAULT 'PENDING',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 🛡️ NEW: Unified Groups Table
    CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        name TEXT DEFAULT 'Unknown', -- 👈 NEW COLUMN
        role TEXT NOT NULL DEFAULT 'UNKNOWN',
        client_code TEXT DEFAULT 'REQ',
        handled_hotels TEXT DEFAULT '["ALL"]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 🛡️ NEW: Client Smart Limits Table
    CREATE TABLE IF NOT EXISTS client_limits (
        group_id TEXT PRIMARY KEY,
        max_child_queries INTEGER DEFAULT 6,
        max_hotels_per_date INTEGER DEFAULT 4,
        max_date_ranges INTEGER DEFAULT 3,
        max_room_types INTEGER DEFAULT 2,
        max_daily_queries INTEGER DEFAULT 30,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 🛡️ NEW: Employees Table (Ignored Users)
    CREATE TABLE IF NOT EXISTS employees (
        jid TEXT PRIMARY KEY,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS child_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER,
        hotel_name TEXT,
        check_in TEXT,
        check_out TEXT,
        room_type TEXT,
        rooms INTEGER,
        persons INTEGER,
        meal TEXT, 
        view TEXT, -- 🛡️ NEW COLUMN FOR VIEW
        status TEXT DEFAULT 'SENT_TO_VENDORS',
        FOREIGN KEY(parent_id) REFERENCES parent_queries(id)
    );

    CREATE TABLE IF NOT EXISTS vendor_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        child_id INTEGER,
        vendor_group_id TEXT,
        sent_message_id TEXT UNIQUE,
        status TEXT DEFAULT 'WAITING',
        FOREIGN KEY(child_id) REFERENCES child_queries(id)
    );

    CREATE TABLE IF NOT EXISTS markup_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_code TEXT DEFAULT 'DEFAULT',
        min_price INTEGER,
        max_price INTEGER,
        markup_amount INTEGER,
        markup_type TEXT DEFAULT 'FIXED'
    );

    CREATE TABLE IF NOT EXISTS group_configs (
        group_id TEXT PRIMARY KEY,
        client_code TEXT
    );

    CREATE TABLE IF NOT EXISTS vendor_quotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id INTEGER,
        raw_reply_text TEXT,
        quoted_price REAL,
        quoted_currency TEXT DEFAULT 'SAR',
        vendor_hotel_name TEXT,
        is_match INTEGER,
        full_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(request_id) REFERENCES vendor_requests(id)
    );
`);

// Safely add new columns to existing tables
    try { db.exec(`ALTER TABLE groups ADD COLUMN limit_tier TEXT DEFAULT 'DEFAULT';`); } catch (e) {}
    try { db.exec(`ALTER TABLE groups ADD COLUMN name TEXT DEFAULT 'Unknown';`); } catch (e) {} // 👈 NEW
    // Safely add new columns to existing tables
    try { db.exec(`ALTER TABLE groups ADD COLUMN limit_tier TEXT DEFAULT 'DEFAULT';`); } catch (e) {}
    try { db.exec(`ALTER TABLE groups ADD COLUMN name TEXT DEFAULT 'Unknown';`); } catch (e) {} 
    try { db.exec(`ALTER TABLE groups ADD COLUMN markup_tier TEXT DEFAULT 'DEFAULT';`); } catch (e) {} // 👈 ADD THIS LINE
// ======================================================
// 🛡️ DATABASE MIGRATION (MEAL & VIEW COLUMN GUARD)
// ======================================================
try {
    const tableInfo = db.prepare("PRAGMA table_info(child_queries)").all();
    
    if (!tableInfo.some(column => column.name === 'meal')) {
        db.exec("ALTER TABLE child_queries ADD COLUMN meal TEXT;");
        console.log("🛠️ Database Migrated: Added 'meal' column to child_queries.");
    }
    
    if (!tableInfo.some(column => column.name === 'view')) {
        db.exec("ALTER TABLE child_queries ADD COLUMN view TEXT;");
        console.log("🛠️ Database Migrated: Added 'view' column to child_queries.");
    }
} catch (e) {
    console.error("⚠️ Migration failed:", e.message);
}


// ======================================================
// 🛡️ INITIALIZE STARTING RULES (RUN ONCE)
// ======================================================
const ruleCount = db.prepare("SELECT count(*) as count FROM markup_rules").get().count;
if (ruleCount === 0) {
    const insert = db.prepare("INSERT INTO markup_rules (client_code, min_price, max_price, markup_amount) VALUES (?, ?, ?, ?)");
    insert.run('DEFAULT', 0, 1000, 20);
    insert.run('DEFAULT', 1000, 99999, 40);
    console.log("✅ Default Markup Rules (+20/+40) have been initialized.");
}

console.log("✅ Database initialized & Tables verified.");

// ======================================================
// 3. PREPARE STATEMENTS
// ======================================================

const saveParent = db.prepare(`
    INSERT INTO parent_queries (message_id, remote_jid, participant, original_text)
    VALUES (@message_id, @remote_jid, @participant, @original_text)
`);

const getQuoteForSending = db.prepare(`
    SELECT 
        vq.full_json,
        pq.remote_jid as client_group_id,
        pq.message_id as client_msg_id,
        pq.participant as client_participant, -- 🛡️ CRITICAL FOR WHATSAPP WEB
        pq.original_text
    FROM vendor_quotes vq
    JOIN vendor_requests vr ON vq.request_id = vr.id
    JOIN child_queries cq ON vr.child_id = cq.id
    JOIN parent_queries pq ON cq.parent_id = pq.id
    WHERE vr.id = ?
    ORDER BY vq.id DESC LIMIT 1
`);

const saveChild = db.prepare(`
    INSERT INTO child_queries (parent_id, hotel_name, check_in, check_out, room_type, rooms, persons, meal, view)
    VALUES (@parent_id, @hotel_name, @check_in, @check_out, @room_type, @rooms, @persons, @meal, @view)
`);

const logRequest = db.prepare(`
    INSERT INTO vendor_requests (child_id, vendor_group_id, sent_message_id)
    VALUES (@child_id, @vendor_group_id, @sent_message_id)
`);

const getContextQuery = db.prepare(`
    SELECT 
        vr.id as request_id,
        vr.vendor_group_id,
        cq.id as child_id,
        cq.hotel_name as requested_hotel,
        cq.check_in,
        cq.check_out,
        cq.room_type,
        cq.rooms,
        cq.persons,
        cq.meal, 
        cq.view,   -- 🛡️ EXPLICITLY SELECT VIEW
        pq.id as parent_id,
        pq.remote_jid as client_group_id,
        pq.message_id as client_msg_id
    FROM vendor_requests vr
    JOIN child_queries cq ON vr.child_id = cq.id
    JOIN parent_queries pq ON cq.parent_id = pq.id
    WHERE vr.sent_message_id = ?
`);

// 🛡️ NEW: Limit Tiers (Packages) Table
    db.exec(`
        CREATE TABLE IF NOT EXISTS limit_tiers (
            tier_name TEXT PRIMARY KEY,
            max_child_queries INTEGER DEFAULT 6,
            max_hotels_per_date INTEGER DEFAULT 4,
            max_date_ranges INTEGER DEFAULT 3,
            max_room_types INTEGER DEFAULT 2,
            max_daily_queries INTEGER DEFAULT 30
        );
        
        -- Insert a standard DEFAULT tier so the bot never crashes
        INSERT OR IGNORE INTO limit_tiers (tier_name, max_child_queries, max_hotels_per_date, max_date_ranges, max_room_types, max_daily_queries)
        VALUES ('DEFAULT', 6, 4, 3, 2, 30);
    `);

    // Safely add the 'limit_tier' column to the existing 'groups' table if it doesn't exist
    try {
        db.exec(`ALTER TABLE groups ADD COLUMN limit_tier TEXT DEFAULT 'DEFAULT';`);
    } catch (e) {
        // Ignore error if column already exists
    }



const updateStatus = db.prepare(`
    UPDATE vendor_requests 
    SET status = @status 
    WHERE id = @reqId
`);

const saveQuote = db.prepare(`
    INSERT INTO vendor_quotes (request_id, raw_reply_text, quoted_price, vendor_hotel_name, is_match, full_json)
    VALUES (@request_id, @raw_reply_text, @quoted_price, @vendor_hotel_name, @is_match, @full_json)
`);

// ======================================================
// 4. HELPER FUNCTIONS
// ======================================================

function getClientCode(groupId) {
    const res = db.prepare("SELECT client_code FROM group_configs WHERE group_id = ?").get(groupId);
    return res ? res.client_code : 'DEFAULT';
}


// 6. Get Full Group Info (For Owner Debugging)
function getGroupInfo(groupId) {
    const group = db.prepare(`SELECT * FROM groups WHERE group_id = ?`).get(groupId);
    if (!group) return null;
    
    const info = { ...group };
    if (group.role === 'CLIENT') {
        info.limits = getClientLimits(groupId);
        info.daily_count = getDailyQueryCount(groupId);
    }
    return info;
}


// ============================================================
// 🛡️ TIER-BASED SMART LIMITS
// ============================================================

// ============================================================
// 🛡️ TIER-BASED SMART LIMITS
// ============================================================

// 1. Get Limits based on the client's assigned Tier
function getClientLimits(groupId) {
    // Check which tier the group belongs to
    const group = db.prepare(`SELECT limit_tier FROM groups WHERE group_id = ?`).get(groupId);
    const tierName = (group && group.limit_tier) ? group.limit_tier : 'DEFAULT';
    
    // Fetch the limits for that tier from the NEW table
    const limits = db.prepare(`SELECT * FROM limit_tiers WHERE tier_name = ?`).get(tierName);
    
    if (limits) return limits;
    
    // Absolute safety fallback
    return { max_child_queries: 6, max_hotels_per_date: 4, max_date_ranges: 3, max_room_types: 2, max_daily_queries: 30 };
}

// ============================================================
// 👨‍💼 INTERNAL EMPLOYEES
// ============================================================

// 1. Add or Update an Employee
function upsertEmployee(jid, name) {
    const stmt = db.prepare(`
        INSERT INTO employees (jid, name) 
        VALUES (?, ?) 
        ON CONFLICT(jid) DO UPDATE SET name = ?
    `);
    stmt.run(jid, name, name);
}

// 2. Check if a User is an Employee
function isEmployeeDB(jid) {
    if (!jid) return false;
    const row = db.prepare(`SELECT 1 FROM employees WHERE jid = ?`).get(jid);
    return !!row; // Returns true if found, false if not
}

// 2. Create or Update a Limit Tier (e.g., VIP, PRO, BASIC)
function upsertLimitTier(tierName, limits) {
    const stmt = db.prepare(`
        INSERT INTO limit_tiers (tier_name, max_child_queries, max_hotels_per_date, max_date_ranges, max_room_types, max_daily_queries)
        VALUES (@tier_name, @max_child, @max_hotel, @max_date, @max_room, @max_daily)
        ON CONFLICT(tier_name) DO UPDATE SET
            max_child_queries = @max_child,
            max_hotels_per_date = @max_hotel,
            max_date_ranges = @max_date,
            max_room_types = @max_room,
            max_daily_queries = @max_daily
    `);
    
    stmt.run({
        tier_name: tierName.toUpperCase(),
        max_child: limits.max_child_queries || 6,
        max_hotel: limits.max_hotels_per_date || 4,
        max_date: limits.max_date_ranges || 3,
        max_room: limits.max_room_types || 2,
        max_daily: limits.max_daily_queries || 30
    });
}

// 3. Assign a Tier to a Client Group
function assignTierToGroup(groupId, tierName) {
    const stmt = db.prepare(`UPDATE groups SET limit_tier = ? WHERE group_id = ?`);
    stmt.run(tierName.toUpperCase(), groupId);
}

// ============================================================
// 👥 UNIFIED GROUP ROUTING (Frontend-Ready)
// ============================================================

// 1. Upsert Group (Creates or Updates a group's role and data)
function upsertGroup(groupId, role, clientCode = 'REQ', handledHotels = ['ALL'], name = 'Unknown') {
    const stmt = db.prepare(`
        INSERT INTO groups (group_id, name, role, client_code, handled_hotels, updated_at) 
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) 
        ON CONFLICT(group_id) DO UPDATE SET 
            name = ?,
            role = ?, 
            client_code = ?, 
            handled_hotels = ?,
            updated_at = CURRENT_TIMESTAMP
    `);
    
    const hotelsStr = Array.isArray(handledHotels) ? JSON.stringify(handledHotels) : handledHotels;
    
    // Pass the name twice (once for INSERT, once for UPDATE)
    stmt.run(groupId, name, role, clientCode, hotelsStr, name, role, clientCode, hotelsStr);
}

// 2. Get Group Role
function getGroupRoleDB(groupId) {
    const row = db.prepare(`SELECT role FROM groups WHERE group_id = ?`).get(groupId);
    return row ? row.role : 'UNKNOWN';
}

// 3. Get Client Code (Only if they are a client)
function getClientCodeDB(groupId) {
    const row = db.prepare(`SELECT client_code FROM groups WHERE group_id = ? AND role = 'CLIENT'`).get(groupId);
    return row ? row.client_code : 'REQ';
}

// 4. Get All Owner Groups (Replaces getOwnerGroups from config)
function getOwnerGroupsDB() {
    const rows = db.prepare(`SELECT group_id FROM groups WHERE role = 'OWNER'`).all();
    return rows.map(r => r.group_id);
}

// 5. Get Vendors for a specific hotel
function getVendorsForHotelDB(hotelName) {
    const normalizedInput = normalizeHotelName(hotelName);
    const inputWords = splitMeaningfulWords(normalizedInput);
    
    const allVendors = db.prepare(`SELECT group_id, handled_hotels FROM groups WHERE role = 'VENDOR'`).all();
    
    const specificMatches = new Set();
    const defaultVendors = new Set();

    for (const vendor of allVendors) {
        let handled;
        try {
            handled = JSON.parse(vendor.handled_hotels);
        } catch (e) { continue; }

        // 1. Add to defaults if they have 'ALL', BUT DO NOT SKIP the specific checks!
        if (handled.includes('ALL')) {
            defaultVendors.add(vendor.group_id);
        }

        // 2. Keyword Matching for specific hotel mappings
        for (const targetHotel of handled) {
            if (targetHotel === 'ALL') continue; // Skip the word 'ALL' for keyword matching

            const targetWords = splitMeaningfulWords(normalizeHotelName(targetHotel));
            if (targetWords.length === 0) continue;

            const isMatch = targetWords.every(word => inputWords.includes(word));
            if (isMatch) {
                specificMatches.add(vendor.group_id);
                break; 
            }
        }
    }

    // 🏆 THE PRIORITY LOGIC:
    // If we found ANY specific vendor for this hotel, return ONLY them.
    // (This will now correctly include Fallback vendors who specifically listed this hotel).
    if (specificMatches.size > 0) {
        return Array.from(specificMatches);
    }

    // If NO specific vendor was found, return the fallback vendors.
    return Array.from(defaultVendors);
}

function updateChildHotelName(childId, newHotelName) {
// 🛡️ THE FIX: Removed getDatabase(). We just use the global 'db' variable directly.
    try {
        db.prepare("UPDATE child_queries SET hotel_name = ? WHERE id = ?").run(newHotelName, childId);
    } catch (err) {
        console.error("❌ Failed to update child hotel name:", err);
    }
}

// 2. Set/Update Limits for a specific group
function setClientLimits(groupId, limits) {
    const stmt = db.prepare(`
        INSERT INTO client_limits (group_id, max_child_queries, max_hotels_per_date, max_date_ranges, max_room_types, max_daily_queries, updated_at)
        VALUES (@group_id, @max_child_queries, @max_hotels_per_date, @max_date_ranges, @max_room_types, @max_daily_queries, CURRENT_TIMESTAMP)
        ON CONFLICT(group_id) DO UPDATE SET
            max_child_queries = @max_child_queries,
            max_hotels_per_date = @max_hotels_per_date,
            max_date_ranges = @max_date_ranges,
            max_room_types = @max_room_types,
            max_daily_queries = @max_daily_queries,
            updated_at = CURRENT_TIMESTAMP
    `);
    
    stmt.run({
        group_id: groupId,
        max_child_queries: limits.max_child_queries,
        max_hotels_per_date: limits.max_hotels_per_date,
        max_date_ranges: limits.max_date_ranges,
        max_room_types: limits.max_room_types,
        max_daily_queries: limits.max_daily_queries
    });
}

// 3. Count how many Parent Queries this group made TODAY
function getDailyQueryCount(groupId) {
    // Uses SQLite 'localtime' to count queries made since midnight
    const stmt = db.prepare(`
        SELECT COUNT(*) as count 
        FROM parent_queries 
        WHERE remote_jid = ? 
        AND date(created_at, 'localtime') = date('now', 'localtime')
    `);
    const result = stmt.get(groupId);
    return result ? result.count : 0;
}

function setGroupClientCode(groupId, clientCode) {
    return db.prepare("INSERT OR REPLACE INTO group_configs (group_id, client_code) VALUES (?, ?)")
        .run(groupId, clientCode);
}

function recallLastParentQueries(count) {
    const parents = db.prepare('SELECT id FROM parent_queries ORDER BY id DESC LIMIT ?').all(count);
    if (!parents.length) return { messages: [], pDeleted: 0, cDeleted: 0 };
    
    const pIds = parents.map(p => p.id);
    const placeholdersP = pIds.map(() => '?').join(',');
    
    const children = db.prepare(`SELECT id FROM child_queries WHERE parent_id IN (${placeholdersP})`).all(pIds);
    const cIds = children.map(c => c.id);
    
    let messages = [];
    if (cIds.length > 0) {
        const placeholdersC = cIds.map(() => '?').join(',');
        messages = db.prepare(`SELECT vendor_group_id, sent_message_id FROM vendor_requests WHERE child_id IN (${placeholdersC})`).all(cIds);
        db.prepare(`DELETE FROM vendor_requests WHERE child_id IN (${placeholdersC})`).run(cIds);
        db.prepare(`DELETE FROM child_queries WHERE id IN (${placeholdersC})`).run(cIds);
    }
    
    db.prepare(`DELETE FROM parent_queries WHERE id IN (${placeholdersP})`).run(pIds);
    return { messages, pDeleted: pIds.length, cDeleted: cIds.length };
}

function normalizeHotelName(name) {
  return name
    ?.toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ======================================================
// 🤖 AUTO-REGISTRATION LOGIC
// ======================================================

function registerUnknownGroup(groupId, groupName) {
    // 1. Double-check it doesn't already exist
    const existing = db.prepare("SELECT group_id FROM groups WHERE group_id = ?").get(groupId);
    if (existing) return false;

    // 2. Find the highest client_code currently in the database
    // We cast it to INTEGER because SQLite sometimes stores it as text
    const result = db.prepare("SELECT MAX(CAST(client_code AS INTEGER)) as max_code FROM groups").get();
    
    // Default to 101 if the database is totally empty, otherwise add 1
    let nextCode = 101; 
    if (result && result.max_code) {
        nextCode = result.max_code + 1;
    }

    // 3. Insert the new group with the UNKNOWN role
    const stmt = db.prepare(`
        INSERT INTO groups (group_id, role, limit_tier, handled_hotels, client_code, name)
        VALUES (?, 'UNKNOWN', 'NONE', '[]', ?, ?)
    `);
    
    stmt.run(groupId, nextCode.toString(), groupName);
    console.log(`\n🆕 [NEW GROUP DETECTED] Auto-Registered: "${groupName}"`);
    console.log(`   ↳ Assigned Code: ${nextCode} | Role: UNKNOWN\n`);
    
    return true;
}

// 2. Updated to include common variations to ignore
// 🛡️ FIX: Added MAKKAH, MADINAH, MADINA to generic words
const GENERIC_WORDS = new Set([
  'HOTEL', 'TOWER', 'TOWERS', 'INN', 'SUITES', 'SUITE', 
  'RESORT', 'APARTMENT', 'APARTMENTS', 'AL', 'EL', 
  'MAKKAH', 'MADINAH', 'MADINA', 'MECCA', 'MEDINA'
]);

function splitMeaningfulWords(text) {
  const words = text.split(' ').filter(w => w.length >= 2);
  
  // Try to filter out generic words
  const meaningful = words.filter(w => !GENERIC_WORDS.has(w));
  
  // 🛡️ THE FIX: If the filter deleted EVERYTHING (e.g., "Makkah Towers"), 
  // then just return the original words so it can still try to match.
  if (meaningful.length === 0 && words.length > 0) {
      return words;
  }
  
  return meaningful;
}

function recallLastChildQueries(count) {
    const children = db.prepare('SELECT id FROM child_queries ORDER BY id DESC LIMIT ?').all(count);
    if (!children.length) return { messages: [], cDeleted: 0 };
    
    const cIds = children.map(c => c.id);
    const placeholdersC = cIds.map(() => '?').join(',');
    
    const messages = db.prepare(`SELECT vendor_group_id, sent_message_id FROM vendor_requests WHERE child_id IN (${placeholdersC})`).all(cIds);
    db.prepare(`DELETE FROM vendor_requests WHERE child_id IN (${placeholdersC})`).run(cIds);
    db.prepare(`DELETE FROM child_queries WHERE id IN (${placeholdersC})`).run(cIds);
    
    return { messages, cDeleted: cIds.length };
}

function getLastActiveRequest(vendorGroupId) {
  return db.prepare(`
    SELECT * FROM vendor_requests 
    WHERE vendor_group_id = ? 
    AND status IN ('SENT', 'PENDING')
    ORDER BY id DESC LIMIT 1
  `).get(vendorGroupId);
}

// 7. Find Group ID by Client Code (Short ID)
function getGroupIdByClientCode(clientCode) {
    // Looks for a CLIENT that matches the short code (e.g., '31')
    const row = db.prepare(`SELECT group_id FROM groups WHERE client_code = ? AND role = 'CLIENT'`).get(clientCode.toString());
    return row ? row.group_id : null;
}

// ======================================================
// 5. EXPORTS
// ======================================================
module.exports = {
    getDatabase: () => db, 
    createParentQuery: (data) => {
        try {
            // 🛡️ THE FIX: Check if we already saved this exact WhatsApp message
            const checkExisting = db.prepare('SELECT id FROM parent_queries WHERE message_id = ?').get(data.message_id);
            
            if (checkExisting) {
                console.log(`⚠️ DB: Caught duplicate WhatsApp message event. Skipping insert to prevent crash.`);
                return checkExisting.id; // Safely return the existing ID so index.js can keep running
            }
            
            // If it's a brand new message, insert it normally
            return saveParent.run(data).lastInsertRowid;
            
        } catch (error) {
            console.log(`❌ DB Error handled safely: ${error.message}`);
            return null;
        }
    },
    
    // 🛡️ REINFORCED: Ensures 'meal' and 'view' are never missing during INSERT
    createChildQuery: (data) => {
        const sanitizedData = {
            ...data,
            meal: data.meal || '',
            view: data.view || '' 
        };
        return saveChild.run(sanitizedData).lastInsertRowid;
    },

    logVendorRequest: (data) => logRequest.run(data).lastInsertRowid,
    db,
    
    getContextBySentMsgId: (msgId) => {
        const row = getContextQuery.get(msgId);
        if (row) {
            console.log(`🔍 DB FETCH [ID:${row.child_id}]: Meal -> "${row.meal}" | View -> "${row.view}"`);
        } else {
            console.log(`🔍 DB FETCH: No record found for MsgID ${msgId}`);
        }
        return row;
    },
    
    saveVendorQuote: (data) => saveQuote.run(data),
    updateRequestStatus: (reqId, status) => updateStatus.run({ reqId, status }),
    getClientCode,
    setGroupClientCode,
    recallLastParentQueries,
    // ADD THESE THREE:
    getClientLimits,
    getGroupIdByClientCode, // 👈 ADD THIS
    setClientLimits,
    getDailyQueryCount,
    recallLastChildQueries,
    getLastActiveRequest,
    upsertGroup,
    registerUnknownGroup,
    getGroupRoleDB,
    getClientCodeDB,
    getGroupInfo,          // 👈 MAKE SURE THIS IS HERE
    getGroupIdByClientCode, // 👈 AND THIS
    getOwnerGroupsDB,
    updateChildHotelName,
    getVendorsForHotelDB,
    upsertLimitTier,     // 👈 NEW
    assignTierToGroup,   // 👈 NEW
    upsertEmployee, // 👈 NEW
    isEmployeeDB,    // 👈 NEW
    getQuoteByReqId: (reqId) => getQuoteForSending.get(reqId),
};