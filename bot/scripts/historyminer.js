// scripts/historyMiner.js
const fs = require('fs'); // 👈 ADDED to check for existing sessions
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys'); 
const qrcode = require('qrcode-terminal'); 
const { db } = require('../src/database'); 
const { parseClientMessageWithAI } = require('../src/aiClientParser');
const { parseVendorMessageWithAI } = require('../src/v2/aiVendorParser');

// ⚠️ Target Vendor Groups
const TARGET_VENDOR_GROUPS = [
    '120363312735747310@g.us',
    '120363297808806322@g.us',
    '120363421799666970@g.us',
    '120363422656893710@g.us',
    '120363419322714295@g.us', 
    '120363366561202735@g.us',
    '120363404455208031@g.us'
];


async function startMiner() {
    console.log("⛏️ Starting WhatsApp History Miner...");
    
    // 🛡️ SMART RESUME: Only wipe DB if we are starting completely fresh
    if (!fs.existsSync('./auth_miner')) {
        resetDatabase();
    } else {
        console.log("♻️ Found existing session. Resuming without wiping the database...");
    }

    // Wrap the connection in a function so we can restart it if it crashes
    async function connectToWA() {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_miner');
        const { version } = await fetchLatestBaileysVersion(); 

        const sock = makeWASocket({
            auth: state,
            version, 
            syncFullHistory: true
        });

        sock.ev.on('creds.update', saveCreds);

        // 🛡️ AUTO-RECONNECT LOGIC
        sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
            if (qr) {
                console.log('\n📲 PLEASE SCAN THIS QR CODE WITH YOUR PHONE:');
                qrcode.generate(qr, { small: true });
            }
            if (connection === 'open') {
                console.log('✅ Miner successfully connected! Waiting for history sync...');
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
                console.log(`❌ Connection dropped by WhatsApp (Error ${lastDisconnect?.error?.output?.statusCode}).`);
                
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting in 3 seconds...');
                    setTimeout(connectToWA, 3000); // Call the function again!
                } else {
                    console.log('🛑 Logged out completely. You must delete the auth_miner folder and scan again.');
                }
            }
        });

        sock.ev.on('messaging-history.set', async ({ messages }) => {
            console.log(`\n📥 RECEIVED HISTORY DUMP: ${messages.length} total messages.`);
            
            const fourteenDaysAgo = Math.floor(Date.now() / 1000) - (14 * 24 * 60 * 60);
            
            let totalOld = 0;
            let totalWrongGroup = 0;
            let totalNotReply = 0;
            
            let oldestInChunk = Math.floor(Date.now() / 1000);
            let newestInChunk = 0;

            const vendorReplies = messages.filter(m => {
                let msgTime = m.messageTimestamp;
                if (typeof msgTime === 'object' && msgTime !== null) {
                    msgTime = msgTime.toNumber ? msgTime.toNumber() : (msgTime.low || 0);
                }
                msgTime = Number(msgTime);

                if (msgTime > 0 && msgTime < oldestInChunk) oldestInChunk = msgTime;
                if (msgTime > newestInChunk) newestInChunk = msgTime;

                if (msgTime < fourteenDaysAgo) {
                    totalOld++;
                    return false;
                }
                
                if (!m.key.remoteJid || !TARGET_VENDOR_GROUPS.includes(m.key.remoteJid)) {
                    totalWrongGroup++;
                    return false;
                }
                
                const contextInfo = m.message?.extendedTextMessage?.contextInfo;
                if (!contextInfo || !contextInfo.quotedMessage) {
                    totalNotReply++;
                    return false;
                }

                return true;
            });

            const oldestDate = new Date(oldestInChunk * 1000).toLocaleDateString();
            const newestDate = new Date(newestInChunk * 1000).toLocaleDateString();
            
            console.log(`📅 CHUNK DATE RANGE: ${oldestDate} to ${newestDate}`);
            console.log(`📊 FILTER BREAKDOWN FOR THIS CHUNK:`);
            console.log(` ➖ Too Old (> 14 days): ${totalOld}`);
            console.log(` ➖ Wrong Chat/Group: ${totalWrongGroup}`);
            console.log(` ➖ Not a Quoted Reply: ${totalNotReply}`);
            console.log(` 🟢 PASSED FILTERS: ${vendorReplies.length}\n`);

            for (const msg of vendorReplies) {
                try {
                    const vendorText = msg.message.extendedTextMessage.text;
                    const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage.conversation || 
                                      msg.message.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text;

                    if (!quotedMsg || !vendorText) continue;

                    console.log(`\n⛏️ Processing Reply:\nQuoted: "${quotedMsg.replace(/\n/g, ' ').substring(0, 50)}..."`);
                    console.log(`Vendor: "${vendorText.replace(/\n/g, ' ').substring(0, 50)}..."`);
                    
                    const prompt = `Extract the hotel, check_in, check_out, room_type, meal, and view from this text. If meal or view are missing, leave them empty. Return ONLY a JSON object with a 'queries' array:\n${quotedMsg}`;
                    const aiQueryResponse = await parseClientMessageWithAI(prompt);
                    
                    if (!aiQueryResponse || !aiQueryResponse.queries || aiQueryResponse.queries.length === 0) {
                        console.log("⚠️ Skipped: AI could not extract query data from the quoted message.");
                        continue;
                    }

                    const reconstructedQuery = aiQueryResponse.queries[0];
                    const actualHotel = reconstructedQuery.hotel;
                    
                    console.log(`🤖 AI Reconstructed context: [${actualHotel} | ${reconstructedQuery.check_in} to ${reconstructedQuery.check_out}]`);

                    const parsedData = await parseVendorMessageWithAI(vendorText, reconstructedQuery);
                    
                    if (parsedData && parsedData.is_valid !== false) {
                        const parentId = db.prepare("INSERT INTO parent_queries (message_id, original_text) VALUES (?, ?)")
                            .run(`HIST_${Date.now()}_${Math.floor(Math.random() * 1000)}`, quotedMsg).lastInsertRowid;
                        
                        const childId = db.prepare("INSERT INTO child_queries (parent_id, hotel_name, check_in, check_out, room_type, rooms, persons, meal, view) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                            .run(
                                parentId, 
                                actualHotel, 
                                reconstructedQuery.check_in, 
                                reconstructedQuery.check_out, 
                                reconstructedQuery.room_type || 'UNKNOWN',
                                reconstructedQuery.rooms || 1,
                                reconstructedQuery.persons || 2,
                                reconstructedQuery.meal || '',   
                                reconstructedQuery.view || ''    
                            ).lastInsertRowid;
                        
                        const requestId = db.prepare("INSERT INTO vendor_requests (child_id, vendor_group_id, sent_message_id) VALUES (?, ?, ?)")
                            .run(childId, msg.key.remoteJid, msg.key.id).lastInsertRowid;
                        
                        db.prepare("INSERT INTO vendor_quotes (request_id, raw_reply_text, vendor_hotel_name, is_match, full_json) VALUES (?, ?, ?, ?, ?)")
                            .run(requestId, vendorText, actualHotel, 1, JSON.stringify(parsedData));
                        
                        console.log(`✅ CACHED: JSON saved successfully for ${actualHotel}`);
                    } else {
                        console.log("⚠️ Skipped: AI deemed the vendor reply invalid or empty.");
                    }
                } catch (e) {
                    console.error("❌ Parse Error:", e.message);
                }

                await new Promise(r => setTimeout(r, 3000));
            }
            
            console.log("\n🎉 CHUNK COMPLETE! WhatsApp sends history in waves.");
            console.log("⏳ Leave this running. When the console is completely quiet for 2 minutes, press Ctrl+C to close.");
        });
    }

    // Start the connection loop
    connectToWA();
}

startMiner();