// src/v2/autoQuoter.js
const { buildClientMessage } = require('./formatter');

// 🛡️ Value Scoring System (COMPARES APPLES TO APPLES)
function getMealScore(meal) {
    const m = (meal || '').toUpperCase();
    if (m.includes('FB')) return 3;
    if (m.includes('HB')) return 2;
    if (m.includes('BB')) return 1;
    return 0; // RO or unknown
}

function getViewScore(view) {
    const v = (view || '').toUpperCase();
    if (v.includes('KAABA')) return 2;
    if (v.includes('HARAM')) return 1;
    return 0; // City View or unknown
}

class AutoQuoter {
    constructor() {
        // ⏳ HOW LONG TO WAIT BEFORE SENDING THE FIRST BATCH?
        this.WAIT_TIME_MS = 5 * 60 * 1000; 
        
        this.timers = new Map();
        this.batchDone = new Set();
        this.activeHotelQuotes = new Map(); // Tracks best active quotes per hotel
        this.quotesQueue = new Map(); 
        this.childToParent = new Map(); 
    }

    linkChildToParent(childId, parentId) {
        // 🛡️ THE FIX: Force to String to prevent integer/string mismatch!
        this.childToParent.set(String(childId), String(parentId));
    }

    startTimer(parentId) {
        const pId = String(parentId); // 🛡️ Force String
        this.quotesQueue.set(pId, []);
        
        console.log(`⏳ AutoQuoter: Started ${this.WAIT_TIME_MS / 60000}-minute countdown for Query ID: ${pId}`);
        
        const timer = setTimeout(async () => {
            this.batchDone.add(pId);
            const quotes = this.quotesQueue.get(pId) || [];
            
            if (quotes.length === 0) return; 

            // Group by Hotel
            const groupedByHotel = {};
            for (const q of quotes) {
                const hotelName = q.v2Quote.hotel;
                if (!groupedByHotel[hotelName]) groupedByHotel[hotelName] = [];
                groupedByHotel[hotelName].push(q);
            }

            // Process each hotel
            for (const hotelName in groupedByHotel) {
                const hotelQuotes = groupedByHotel[hotelName];
                
                // Sort quotes from Lowest Price to Highest Price
                hotelQuotes.sort((a, b) => a.v2Quote.total_price - b.v2Quote.total_price);
                
                const bestValueQuotes = []; 

                // Check if a more expensive quote is actually worth sending
                for (const q of hotelQuotes) {
                    const mScore = getMealScore(q.v2Quote.applied_meal);
                    const vScore = getViewScore(q.v2Quote.applied_view);
                    const price = q.v2Quote.total_price;

                    let isUseless = false;

                    for (const winner of bestValueQuotes) {
                        const wMeal = getMealScore(winner.v2Quote.applied_meal);
                        const wView = getViewScore(winner.v2Quote.applied_view);
                        
                        // If an already accepted quote is CHEAPER and EQUAL/BETTER, this quote is useless.
                        if (wMeal >= mScore && wView >= vScore) {
                            isUseless = true;
                            break;
                        }
                    }

                    if (!isUseless) {
                        bestValueQuotes.push(q);
                    }
                }

                // Send the winners and save them to memory
                const parentHotelKey = `${pId}_${hotelName}`;
                const activeList = [];

                for (const best of bestValueQuotes) {
                    const mScore = getMealScore(best.v2Quote.applied_meal);
                    const vScore = getViewScore(best.v2Quote.applied_view);
                    const displayCombo = `[${best.v2Quote.applied_meal} | ${best.v2Quote.applied_view}]`;

                    activeList.push({ price: best.v2Quote.total_price, mealScore: mScore, viewScore: vScore });
                    
                    console.log(`🏆 AutoQuoter: Timer Finished! Sending ${hotelName} ${displayCombo}: ${best.v2Quote.total_price} SAR`);
                    await this.sendToClient(best.sock, best.quoteData, best.v2Quote, false);
                }

                this.activeHotelQuotes.set(parentHotelKey, activeList);
            }

            // Clear timer memory
            this.quotesQueue.delete(pId);
            this.timers.delete(pId);
        }, this.WAIT_TIME_MS);

        this.timers.set(pId, timer);
    }

    async evaluateQuote(v2Quote, quoteData, childId, sock) {
        const cId = String(childId); // 🛡️ Force String
        const pId = this.childToParent.get(cId) || String(quoteData.parent_id || childId);
        const parentHotelKey = `${pId}_${v2Quote.hotel}`; 

        // A. Put in Waiting Room if Timer is still ticking
        if (pId && this.timers.has(pId) && !this.batchDone.has(pId)) {
            this.quotesQueue.get(pId).push({ v2Quote, quoteData, childId: cId, sock });
            console.log(`⏱️ AutoQuoter: Queued quote for ${v2Quote.hotel} (Waiting for timer on Query ${pId}...)`);
            return;
        }

        // B. Timer is done! LATE REPLY EVALUATION
        let activeQuotes = this.activeHotelQuotes.get(parentHotelKey) || [];

        const newMealScore = getMealScore(v2Quote.applied_meal);
        const newViewScore = getViewScore(v2Quote.applied_view);
        const newPrice = v2Quote.total_price;
        const displayCombo = `[${v2Quote.applied_meal} | ${v2Quote.applied_view}]`;

        // 1. Is this new quote useless compared to what we already sent?
        let isUseless = false;
        for (const aq of activeQuotes) {
            if (aq.price <= newPrice && aq.mealScore >= newMealScore && aq.viewScore >= newViewScore) {
                isUseless = true;
                break;
            }
        }

        if (isUseless) {
            console.log(`🗑️ AutoQuoter: Discarded ${v2Quote.hotel} ${displayCombo} @ ${newPrice} SAR. (Already sent equal/better).`);
            return;
        }

        // 2. Add our new champion to the active list
        const updatedActiveQuotes = [];
        for (const aq of activeQuotes) {
            // Drop old quotes if this new one is cheaper AND better
            if (newPrice <= aq.price && newMealScore >= aq.mealScore && newViewScore >= aq.viewScore) {
                // Drop it
            } else {
                updatedActiveQuotes.push(aq);
            }
        }

        updatedActiveQuotes.push({ price: newPrice, mealScore: newMealScore, viewScore: newViewScore });
        this.activeHotelQuotes.set(parentHotelKey, updatedActiveQuotes);

        console.log(`📉 AutoQuoter: NEW VALUABLE OPTION for ${v2Quote.hotel} ${displayCombo} @ ${newPrice} SAR! Sending...`);
        
        const isRevised = activeQuotes.length > 0;
        await this.sendToClient(sock, quoteData, v2Quote, isRevised);
    }

    async sendToClient(sock, quoteData, v2Quote, isRevised) {
        const finalMsg = buildClientMessage(v2Quote, 0); 
        
// 🛡️ THE FIX: Re-introduce the single header variable safely
        const header = "*REVISED*\n\n";

        await sock.sendMessage(quoteData.client_group_id, {
            text: header + finalMsg
        }, { 
            quoted: {
                key: {
                    remoteJid: quoteData.client_group_id,
                    fromMe: false,                               
                    id: quoteData.client_msg_id,
                    participant: quoteData.client_participant    
                },
                message: { conversation: quoteData.original_text || "Original Query" }
            }
        });
    }
}

module.exports = new AutoQuoter();