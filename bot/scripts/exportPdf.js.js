// scripts/exportPdf.js
const { jsPDF } = require("jspdf");
const autoTable = require("jspdf-autotable").default;
const { db } = require('../src/database');
const fs = require('fs');

async function generateReport() {
    console.log("📄 Generating Detailed PDF Breakdown (Now with Meal Charges)...");

    try {
        const rows = db.prepare(`
            SELECT 
                cq.hotel_name, cq.check_in, cq.check_out, cq.room_type,
                cq.meal as query_meal, cq.view as query_view,
                vq.full_json
            FROM vendor_quotes vq
            JOIN vendor_requests vr ON vq.request_id = vr.id
            JOIN child_queries cq ON vr.child_id = cq.id
            ORDER BY cq.hotel_name ASC, cq.check_in ASC
        `).all();

        if (rows.length === 0) {
            console.log("⚠️ No data found. Is the miner finished?");
            return;
        }

        const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

        // 1. Header
        doc.setFontSize(16);
        doc.text("Hotel Rate Breakdown Report (V3 Mined Data)", 14, 15);
        doc.setFontSize(9);
        doc.setTextColor(100);
        doc.text(`Generated: ${new Date().toLocaleString()} | Currency: SAR`, 14, 20);

        // 2. Table Setup
        const tableColumn = [
            "Hotel", 
            "Dates", 
            "Base Room", 
            "Meal & Charges", // 👈 Updated Column Header
            "Rate", 
            "Ex. Bed", 
            "Surcharges (Haram/Kaaba)"
        ];
        
        const tableRows = [];

        rows.forEach(row => {
            const data = JSON.parse(row.full_json);
            
            // Format Rates & Breakdowns
            const dateRange = `${row.check_in}\nto ${row.check_out}`;
            const roomInfo = `${row.room_type}\n(${data.quoted_base_capacity || 2} Pax)`;
            
            // 🍔 MEAL & CHARGES LOGIC
            let mealInfo = data.base_meal_plan || row.query_meal || "RO";
            let mealAddons = [];
            
            // Catch variations of how the AI might have stored meal prices
            const mealData = data.meal_surcharges || data.meal_prices || data.meal_rates;
            
            if (mealData && typeof mealData === 'object') {
                for (const [type, price] of Object.entries(mealData)) {
                    if (price && price > 0) {
                        mealAddons.push(`${type.toUpperCase()}: +${price}`);
                    }
                }
            } else if (data.meal_price && data.meal_price > 0) {
                // Catch single meal price
                mealAddons.push(`+${data.meal_price}`);
            }

            // Append charges if any exist
            if (mealAddons.length > 0) {
                mealInfo += `\n---\n${mealAddons.join('\n')}`;
            }
            
            // Handle Split Rates (Breakdown by date/weekday)
            let rateDetails = "";
            if (data.split_rates && data.split_rates.length > 0) {
                rateDetails = data.split_rates.map(r => 
                    `${r.dates}: ${r.rate} (${r.type || 'Base'})`
                ).join("\n");
            } else {
                rateDetails = `Flat: ${data.rate || 'N/A'}`;
            }

            // Extra Bed & Surcharges
            const extraBed = data.extra_bed_price > 0 ? `${data.extra_bed_price}` : "Incl./No";
            const surcharges = `Haram: +${data.view_surcharges?.haram || 0}\nKaaba: +${data.view_surcharges?.kaaba || 0}`;

            tableRows.push([
                row.hotel_name,
                dateRange,
                roomInfo,
                mealInfo,
                rateDetails,
                extraBed,
                surcharges
            ]);
        });

        // 3. Generate Table
        autoTable(doc, {
            startY: 25,
            head: [tableColumn],
            body: tableRows,
            theme: 'grid',
            headStyles: { fillColor: [22, 160, 133], textColor: 255, fontSize: 9 },
            bodyStyles: { fontSize: 8, cellPadding: 3 },
            columnStyles: {
                0: { cellWidth: 45, fontStyle: 'bold' }, // Hotel
                1: { cellWidth: 25 },                   // Dates
                3: { cellWidth: 25 },                   // Meal (gave it a fixed width so it wraps nicely)
                4: { cellWidth: 50 },                   // Rate Breakdown
                6: { cellWidth: 35 }                    // Surcharges
            },
            didParseCell: function(data) {
                // Highlighting valid rows
                if (data.column.index === 4) data.cell.styles.fontStyle = 'bold';
            }
        });

        const fileName = `Rate_Breakdown_${Date.now()}.pdf`;
        fs.writeFileSync(fileName, Buffer.from(doc.output("arraybuffer")));

        console.log(`\n✅ BREAKDOWN COMPLETE! Saved as: ${fileName}`);

    } catch (err) {
        console.error("❌ Export Error:", err);
    }
}

generateReport();