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

// ======================================================
// 5. EXPORTS
// ======================================================
module.exports = {
    getDatabase: () => db, 
    createParentQuery: (data) => saveParent.run(data).lastInsertRowid,
    
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
    recallLastChildQueries,
    getLastActiveRequest,
    getQuoteByReqId: (reqId) => getQuoteForSending.get(reqId),
};