// test-personalization-data.js
//
// Regression guard for the intro-template personalization bug where the 3-way
// intro went out reading "hi Miera of , this is Alcris, here is " — {company}
// and {primary full name} rendered blank. Pure: no DB/browser.
// Run: node test-personalization-data.js

const { personalizationData } = require("./campaign-autointro");

let failures = 0;
function eq(a, b, m) { if (a !== b) { failures++; console.error(`❌ ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); } else { console.log("✅", m); } }

// Lead as ingested: dedicated columns blank, structured fields in row_data
// (the source-sheet row carried through by the app).
const lead = {
  full_name: "Miera Rotas", first_name: "", last_name: "", company: "", title: "",
  row_data: { "First Name": "Miera", "Last Name": "Rotas", "Company": "Google", "Title": "Head of Ops" },
};
const d = personalizationData(lead, "Antonio Varlese", "https://linkedin.com/in/antoniovarlese", "Alcris");

eq(d["first name"], "Miera", "first name");
eq(d["company"], "Google", "{company} fills from row_data (was blank in prod)");
eq(d["title"], "Head of Ops", "{title} fills from row_data");
eq(d["full name"], "Miera Rotas", "{full name} routing key = First + Last (app auto-intro.js:707)");
eq(d["primary full name"], "Antonio Varlese", "{primary full name} key now exists (was missing)");
eq(d["primary name"], "Antonio Varlese", "{primary name}");
eq(d["primary first name"], "Antonio", "{primary first name}");
eq(d["primary last name"], "Varlese", "{primary last name}");
eq(d["intro name"], "Antonio Varlese", "{intro name} = primary (group intro)");
eq(d["intro last name"], "Varlese", "{intro last name} now exists (audit #22)");
eq(d["sender first name"], "Alcris", "{sender first name}");
eq(d["sender name"], "Alcris", "{sender name} resolves to nice name (audit #20; matches campaign-action.js)");

// Custom source-sheet columns must survive as tokens (audit #3). row_data is
// spread first, so {Event}, {City}, any header the operator typed, resolves.
const leadCustom = {
  full_name: "Custom Col", first_name: "Custom", last_name: "Col",
  row_data: { "First Name": "Custom", "Last Name": "Col", "Event": "Dubai Summit", "City": "Dubai" },
};
const dc = personalizationData(leadCustom, "Pat Primary", "", "Sam");
eq(dc["Event"], "Dubai Summit", "custom {Event} column resolves (was dropped on VM)");
eq(dc["City"], "Dubai", "custom {City} column resolves");

// App parity: the SHEET column (row_data) wins — the app only ever reads the
// sheet row, so a live column beats the (usually blank) structured field.
const lead2 = { full_name: "Jane Doe", company: "", row_data: { "Company": "SheetCo" } };
eq(personalizationData(lead2, "Pat Primary", "", "Sam")["company"], "SheetCo", "sheet Company column wins (app-faithful)");

// Structured field is the FALLBACK when row_data has no such column.
const lead2b = { full_name: "Jane Doe", company: "StructCo", row_data: { "First Name": "Jane" } };
eq(personalizationData(lead2b, "Pat Primary", "", "Sam")["company"], "StructCo", "structured company used when row_data lacks the column");

// No row_data + blank column → empty string, not crash.
const lead3 = { full_name: "No Co", company: "" };
eq(personalizationData(lead3, "Pat", "", "Sam")["company"], "", "missing company → '' (no crash)");

if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
console.log("\nAll personalization tests passed.");
