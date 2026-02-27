const { upsertGroup, upsertEmployee } = require('./database');

console.log("⏳ Starting LIVE Production Group Migration...");

try {
    // 1. ADD OWNER
    upsertGroup('120363406811283329@g.us', 'OWNER', 'REQ', ['ALL'], 'Master Admin');
    console.log("✅ Owner migrated.");

    // 2. LIVE CLIENTS (Mapped with Names)
    const CLIENTS = {
        31:  { jid: '120363402732966312@g.us', name: 'MMT' },
        28:  { jid: '120363318495685441@g.us', name: 'FAUZ' },
        27:  { jid: '120363365926008685@g.us', name: 'SURE' },
        22:  { jid: '120363307647306024@g.us', name: 'Shine Star' },
        68:  { jid: '120363419620852660@g.us', name: 'NS TRAVEL' },
        50:  { jid: '120363418165371511@g.us', name: 'ETT' },
        56:  { jid: '120363318225645510@g.us', name: '360' },
        19:  { jid: '120363333382742462@g.us', name: 'IDEAL' },
        57:  { jid: '120363413679734097@g.us', name: 'HUJJAJ' },
        38:  { jid: '120363367273180779@g.us', name: 'HAMZA' },
        71:  { jid: '120363418288464681@g.us', name: 'GREEN WORLD' },
        102: { jid: '120363404629591682@g.us', name: 'PSL' },
        52:  { jid: '120363401398569190@g.us', name: 'Musafirana' },
        47:  { jid: '120363398132182401@g.us', name: 'ABDULLAH' },
        69:  { jid: '120363400986591876@g.us', name: 'MEHER' },
        101: { jid: '120363423088872253@g.us', name: 'TEST' },
        16:  { jid: '120363306102166734@g.us', name: 'UN TRAVEL' },
        51:  { jid: '120363419358131159@g.us', name: 'WORLD VISIT' },
        15:  { jid: '120363321504929035@g.us', name: 'ABID' },
        109: { jid: '120363302168956004@g.us', name: 'DAW' },
        78:  { jid: '120363403285078510@g.us', name: 'EVENTICA' },
        54:  { jid: '120363393564468120@g.us', name: 'AL HADI' },
        48:  { jid: '120363265181436578@g.us', name: 'AL WAHA' },
        55:  { jid: '120363417198496338@g.us', name: 'SMJ' },
        88:  { jid: '120363322939894335@g.us', name: 'AL ASIF' },
        29:  { jid: '120363343833236598@g.us', name: 'KARVAN-E-Royal' },
        108: { jid: '120363316525917807@g.us', name: 'YAHYA' },
        104: { jid: '120363314618782087@g.us', name: 'DASHT' },
        67:  { jid: '120363403498808203@g.us', name: 'TALHA TEMPTATIONS' },
        35:  { jid: '120363365263487755@g.us', name: 'ROSHAN TRAVELS' }
    };

    let clientCount = 0;
    for (const [code, data] of Object.entries(CLIENTS)) {
        upsertGroup(data.jid, 'CLIENT', code.toString(), ['ALL'], data.name);
        clientCount++;
    }
    console.log(`✅ Migrated ${clientCount} Live Clients with names.`);

    // 3. LIVE VENDORS (Mapped with Names)
    const VENDORS = {
        900: { jid: '120363423848269620@g.us', name: 'TEST Vendor' },
        901: { jid: '120363421799666970@g.us', name: 'FlyUnique' },
        902: { jid: '120363312735747310@g.us', name: 'HBA Trvl Hotel VS Nwtt' },
        905: { jid: '120363297808806322@g.us', name: 'Agent HBA PAK / ATT266' },
        906: { jid: '120363421038166711@g.us', name: 'HBA 1540 🤝 ASKANT' },
        907: { jid: '120363422210264688@g.us', name: 'HBA 🤝 KENZI HOSPITALITY 49' },
        908: { jid: '120363422656893710@g.us', name: 'HBA-Imran Bhai' },
        909: { jid: '120363419322714295@g.us', name: '475 HBA 🤝 ALSUBAEE HOLIDAYS' },
        910: { jid: '120363366561202735@g.us', name: 'Aden' },
        911: { jid: '120363404455208031@g.us', name: 'Arkaan' },
        912: { jid: '120363421934695518@g.us', name: 'HLT' },
        913: { jid: '120363299136246491@g.us', name: 'WOSOL' },
        914: { jid: '120363314562298136@g.us', name: 'RITAJ' },
        915: { jid: '120363420882619412@g.us', name: 'SERB' },
        916: { jid: '120363420601536045@g.us', name: 'SEDRA' },
        917: { jid: '120363308383480158@g.us', name: 'SMOOTH' },
        918: { jid: '120363315331091127@g.us', name: 'IMS' },
        919: { jid: '120363320286132315@g.us', name: 'UNIWORLD' },
        920: { jid: '120363402200576408@g.us', name: 'JANATAN' },
        921: { jid: '120363399150192081@g.us', name: 'HAMMAD' },
        922: { jid: '120363347278514375@g.us', name: 'TABARAK' },
        923: { jid: '120363336336214623@g.us', name: 'MAYSAN' }
    };

    // 4. HOTEL -> VENDOR MAP
    const HOTEL_VENDOR_MAP = {
        'Anwar Al Madinah': [905, 909, 912],
        'Saja Al Madinah': [905, 909, 912],
        'Saja Makkah': [905, 911],
        'Pullman Zamzam Madinah': [906, 905, 901, 910],
        'Madinah Hilton': [918, 910],
        'Shahd Al Madinah': [901, 902],
        'The Oberoi Madina': [915],
        'Dar Al Taqwa': [902],
        'Dar Al Iman InterContinental': [918],
        'Dar Al Hijra InterContinental': [918],
        'Movenpick Madinah': [905, 909, 912],
        'Crowne Plaza Madinah': [913],
        'Leader Al Muna Kareem': [905],
        'Odst Al Madinah': [914, 902, 901],
        'Artal Al Munawara': [901, 902, 914],
        'Zowar International': [901, 902, 914],
        'Taiba Front': [923],
        'Aqeeq Madinah': [923, 915],
        'Frontel Al Harithia': [923, 918],
        'Dallah Taibah': [901, 905, 902],
        'Golden Tulip Al Zahabi': [901],
        'Al Mukhtara International': [914, 902, 901],
        'Al Haram Hotel': [915, 902],
        'Province Al Sham': [914],
        'Fairmont Makkah Clock Royal Tower': [901, 902, 905, 906, 910, 913, 919],
        'Swissotel Makkah': [901, 902, 905, 906, 910, 913, 919],
        'Swissotel Al Maqam': [901, 902, 905, 906, 910, 913, 919],
        'Raffles Makkah Palace': [901, 902, 905, 906, 910, 913, 919],
        'Pullman Zamzam Makkah': [901, 902, 905, 906, 910, 913, 919],
        'Movenpick Hajar Tower': [901, 902, 905, 906, 910, 913, 919],
        'Al Marwa Rayhaan by Rotana': [901, 902, 905, 906, 910, 913, 919],
        'Makkah Hotel': [907, 908, 905, 902, 901], 
        'Makkah Towers': [907, 908, 905, 902, 901], 
        'Hilton Makkah Convention': [910],
        'Hilton Suites Makkah': [901, 910],
        'Hyatt Regency Makkah': [922],
        'Conrad Makkah': [922, 901, 902],
        'Jabal Omar Marriott': [913, 905, 907],
        'Address Jabal Omar': [913, 922],
        'Sheraton Makkah Jabal Al Kaaba': [922],
        'DoubleTree by Hilton Makkah': [910],
        'Le Meridien Makkah': [901],
        'Waqf Uthman': [914, 902, 901],
        'Safwa Tower': [910, 906],
        'Voco Makkah': [901, 902, 910, 911, 913],
        'Kiswa Towers': [910, 908, 906],
        'Elaf Ajyad': [902, 901],
        'Le Meridien Towers Makkah': [919],
        'Novotel Makkah Thakher City': [917],
        'Holiday Inn Makkah Al Aziziah': [919]
    };

    // Add Internal Employees
    upsertEmployee('13026770075820@lid', 'Shaheer 2');
    upsertEmployee('173942400651429@lid', 'SHAHEER');
    upsertEmployee('243159590269138@lid', 'ANAS');
    console.log("✅ Employees migrated.");

    const vendorHotels = {};
    for (const [vid, _] of Object.entries(VENDORS)) vendorHotels[vid] = []; 
    for (const [hotelName, vids] of Object.entries(HOTEL_VENDOR_MAP)) {
        for (const vid of vids) {
            if (vendorHotels[vid]) vendorHotels[vid].push(hotelName);
        }
    }

    // Default Catch-All Vendors
    vendorHotels[900] = ['ALL'];
    vendorHotels[901] = ['ALL'];
    vendorHotels[902] = ['ALL'];
    vendorHotels[905] = ['ALL'];

    let vendorCount = 0;
    for (const [vid, data] of Object.entries(VENDORS)) {
        const handled = vendorHotels[vid] && vendorHotels[vid].length > 0 ? vendorHotels[vid] : ['ALL'];
        upsertGroup(data.jid, 'VENDOR', 'REQ', handled, data.name);
        vendorCount++;
    }
    console.log(`✅ Migrated ${vendorCount} Live Vendors with specific Hotel Maps and names.`);

    console.log("\n🎉 LIVE MIGRATION COMPLETE! The database is ready for Turalex.");
    process.exit(0);

} catch (err) {
    console.error("❌ Migration Failed:", err);
    process.exit(1);
}