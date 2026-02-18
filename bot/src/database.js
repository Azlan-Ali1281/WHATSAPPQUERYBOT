const Database = require('better-sqlite3');
const path = require('path');

// 1. CONNECT TO DATABASE
const db = new Database(path.join(__dirname, '../bot.db'), { verbose: null }); // Change null to console.log for debug

// ======================================================
// 2. INITIALIZE TABLES (IMMEDIATELY)
// ======================================================
// We run this NOW so tables exist before we prepare statements below.

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

console.log("✅ Database initialized & Tables verified.");

// ======================================================
// 3. PREPARE STATEMENTS (Now safe to run)
// ======================================================

const saveParent = db.prepare(`
    INSERT INTO parent_queries (message_id, remote_jid, participant, original_text)
    VALUES (@message_id, @remote_jid, @participant, @original_text)
`);

const saveChild = db.prepare(`
    INSERT INTO child_queries (parent_id, hotel_name, check_in, check_out, room_type, rooms, persons)
    VALUES (@parent_id, @hotel_name, @check_in, @check_out, @room_type, @rooms, @persons)
`);

const logRequest = db.prepare(`
    INSERT INTO vendor_requests (child_id, vendor_group_id, sent_message_id)
    VALUES (@child_id, @vendor_group_id, @sent_message_id)
`);

// Join tables to recover full context from a vendor's reply
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
        pq.id as parent_id,
        pq.remote_jid as client_group_id,
        pq.message_id as client_msg_id
    FROM vendor_requests vr
    JOIN child_queries cq ON vr.child_id = cq.id
    JOIN parent_queries pq ON cq.parent_id = pq.id
    WHERE vr.sent_message_id = ?
`);

// ➤ UPDATE STATUS (Mark request as REPLIED)
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
// 4. EXPORTS
// ======================================================
module.exports = {
    // We don't need initDatabase anymore since it runs on load
    createParentQuery: (data) => saveParent.run(data).lastInsertRowid,
    createChildQuery: (data) => saveChild.run(data).lastInsertRowid,
    logVendorRequest: (data) => logRequest.run(data).lastInsertRowid,
    getContextBySentMsgId: (msgId) => getContextQuery.get(msgId),
    saveVendorQuote: (data) => saveQuote.run(data),
    // 👇 ADD THIS NEW EXPORT
    updateRequestStatus: (reqId, status) => updateStatus.run({ reqId, status })
};