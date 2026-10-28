/*
  Van Reservations configuration
  ------------------------------
  1. Paste your Google Apps Script "Web app URL" below (see README.md, Step 2).
  2. Leave it blank to run in demo mode (bookings save only in your browser).
*/
window.VAN_CONFIG = {
  // Web app URL from Apps Script (ends in /exec)
  apiUrl: "https://script.google.com/macros/s/AKfycbxDWYf7D7bBN5EV095YV8VVIJgyi2xJICE6A13LpPDbL74TqyGvebuZ3ERmrvGaIX8F/exec",   // LIVE sheet web app

  // W&L Microsoft 365 (Outlook) sign-in. See README.md, Step 3.
  // Leave clientId blank to skip sign-in (demo or testing only).
  auth: {
    clientId: "",          // Application (client) ID from Microsoft Entra
    tenantId: "",          // Directory (tenant) ID from Microsoft Entra
    redirectUri: ""        // Leave blank to use this page's address
  },

  // Only accounts at this domain can book
  emailDomain: "wlu.edu",

  // Optional: longest reservation allowed, in days. Use null for no limit.
  maxDays: null,

  // The fleet. "id" must match the van numbers in Code.gs.
  vans: [
    { id: "97",  name: "Van 97" },
    { id: "140", name: "Van 140" },
    { id: "203", name: "Van 203" },
    { id: "206", name: "Van 206" },
    { id: "207", name: "Van 207" },
    { id: "208", name: "Mini Van 208" },
    { id: "209", name: "Mini Van 209" }
  ],

  // MiFis. "id" must match the MiFi numbers in Code.gs.
  mifis: [
    { id: "1", name: "MiFi 1" },
    { id: "2", name: "MiFi 2" },
    { id: "3", name: "MiFi 3" },
    { id: "4", name: "MiFi 4" },
    { id: "5", name: "MiFi 5" },
    { id: "6", name: "MiFi 6" },
    { id: "8", name: "MiFi 8" }
  ],

  // Team list for the booking form. The live site reads the list from the sheet's "Lists" tab
  // (same choices as the van tab TEAM column), so this copy is only used if the sheet can't be reached.
  teams: [
    "Athletic Training (AT)",
    "Baseball (BASE)",
    "Field Hockey (FH)",
    "Football (FB)",
    "Men's Basketball (MBB)",
    "Men's Cross Country (MXC)",
    "Men's Golf (MGOLF)",
    "Men's Lacrosse (MLAX)",
    "Men's Soccer (MSOC)",
    "Men's Tennis (MTEN)",
    "Men's Track & Field (MT&F)",
    "Riding (RIDE)",
    "Swimming (SWIM)",
    "Volleyball (VB)",
    "Women's Basketball (WBB)",
    "Women's Cross Country (WXC)",
    "Women's Golf (WGOLF)",
    "Women's Lacrosse (WLAX)",
    "Women's Soccer (WSOC)",
    "Women's Tennis (WTEN)",
    "Women's Track & Field (WT&F)",
    "Wrestling (WRES)",
    "Other / Non-Athletics"
  ]
};
