const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");

let sheetsClient = null;
let cachedServiceAccountEmail = null;

/**
 * Read the configured service account email (for surfacing in UI errors so
 * users know which address to share their sheet with). Returns "" if we
 * can't read it for any reason.
 */
function getServiceAccountEmail() {
  if (cachedServiceAccountEmail !== null) return cachedServiceAccountEmail;

  try {
    let raw;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    } else {
      const keyPath =
        process.env.GOOGLE_SERVICE_ACCOUNT_PATH ||
        path.join(__dirname, "service-account.json");
      if (!fs.existsSync(keyPath)) {
        cachedServiceAccountEmail = "";
        return cachedServiceAccountEmail;
      }
      raw = fs.readFileSync(keyPath, "utf-8");
    }

    const trimmed = String(raw).trim();
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (_) {
      // Defensive: same braces-missing fallback used by getSheets()
      if (!trimmed.startsWith("{") && trimmed.includes('"type"')) {
        parsed = JSON.parse("{" + trimmed + "}");
      } else {
        throw new Error("could not parse service account credentials");
      }
    }
    cachedServiceAccountEmail = parsed.client_email || "";
  } catch (_) {
    cachedServiceAccountEmail = "";
  }
  return cachedServiceAccountEmail;
}

/**
 * Recognise a Google Sheets "not shared with this caller" / 403 error so the
 * scraper can stop early and surface a useful message instead of plowing
 * through hundreds of pages writing zero rows.
 */
function isPermissionError(err) {
  if (!err) return false;
  const code = err.code || err.status || err?.response?.status;
  if (code === 403 || code === "403") return true;
  const msg = String(err.message || "").toLowerCase();
  return (
    msg.includes("caller does not have permission") ||
    msg.includes("permission denied") ||
    msg.includes("the user does not have permission") ||
    msg.includes("does not have access") ||
    msg.includes("forbidden")
  );
}

/**
 * Decode a LinkedIn member URN (base64-encoded) to a numeric member ID.
 * e.g. "ACwAAAs7MaoB7F4OJDrvvN7ztmz2By_PBs_tV-E" â†’ "188428714"
 *
 * LinkedIn URNs are base64url-encoded byte sequences. The numeric member ID
 * is stored as a big-endian integer starting at byte 4 (after a 4-byte prefix).
 */
function decodeMemberUrn(urn) {
  try {
    if (!urn || typeof urn !== "string") return null;

    // Convert base64url to standard base64
    let b64 = urn.replace(/-/g, "+").replace(/_/g, "/");
    // Add padding if needed
    while (b64.length % 4 !== 0) b64 += "=";

    const buffer = Buffer.from(b64, "base64");

    // The numeric ID is a 4-byte big-endian integer starting at offset 4
    if (buffer.length >= 8) {
      const memberId = buffer.readUInt32BE(4);
      if (memberId > 0 && memberId < 4294967295) {
        return String(memberId);
      }
    }

    // Fallback: try reading from different offsets
    if (buffer.length >= 4) {
      const memberId = buffer.readUInt32BE(0);
      if (memberId > 1000 && memberId < 4294967295) {
        return String(memberId);
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Authenticate using a Google Cloud service account and return
 * a cached Sheets API client.
 */
async function getSheets() {
  if (sheetsClient) return sheetsClient;

  const keyPath =
    process.env.GOOGLE_SERVICE_ACCOUNT_PATH ||
    path.join(__dirname, "service-account.json");

  // Support either a file path OR the raw JSON in an env variable
  // (Railway lets you paste the full JSON into an env var)
  let credentials;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else if (fs.existsSync(keyPath)) {
    credentials = JSON.parse(fs.readFileSync(keyPath, "utf-8"));
  } else {
    throw new Error(
      "No service account found. Either set GOOGLE_SERVICE_ACCOUNT_JSON env var " +
        "or place service-account.json in the project root. " +
        "See README for setup instructions."
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

/**
 * Extract the spreadsheet ID from a full Google Sheets URL.
 */
function extractSheetId(sheetUrl) {
  const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error(`Invalid Google Sheet URL: ${sheetUrl}`);
  return match[1];
}

/**
 * Ensure the target tab exists. If it doesn't, create it.
 */
async function ensureTab(sheets, spreadsheetId, tabName) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const exists = meta.data.sheets.some((s) => s.properties.title === tabName);

    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: tabName } } }],
        },
      });
    }
  } catch (err) {
    if (err.message?.includes("not found") || err.code === 404) {
      throw new Error(
        "Spreadsheet not found. Make sure you shared the sheet with your service account email."
      );
    }
    throw err;
  }
}

/**
 * Write a header row if the tab is empty.
 */
async function ensureHeaders(sheets, spreadsheetId, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tabName}'!A1:AE1`,
  });

  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tabName}'!A1:AE1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [
          [
            "Record ID",
            "First Name",
            "Last Name",
            "Domain",
            "Priority (Company)",
            "Priority (Role)",
            "Priority",
            "Lead Status",
            "Company Name",
            "Job Title",
            "Linkedin Bio",
            "First Phone",
            "First Phone Validation",
            "Phone Number",
            "Whatsapp Link",
            "Mobile Phone Number",
            "Email",
            "Email Verification",
            "LinkedIn Membership ID",
            "Location",
            "Notes",
            "Secondary Emails",
            "Hubspot URL",
            "Ortus Membership",
            "Current Tag",
            "Open Profile",
            "Premium Account",
            "Linkedin First Connections",
            "Client Lead Status",
            "Apollo Contact ID",
            "Additional email addresses",
          ],
        ],
      },
    });
  }
}

/**
 * Send scraped profiles directly to a Google Sheet via the Sheets API.
 * Output format matches the C.2 tab structure from the original extension workflow.
 */
async function sendToSheet({ profiles, sheetUrl, tabName }) {
  const sheets = await getSheets();
  const spreadsheetId = extractSheetId(sheetUrl);
  const tab = tabName || "Sheet1";

  // Make sure the tab exists and has headers
  await ensureTab(sheets, spreadsheetId, tab);
  await ensureHeaders(sheets, spreadsheetId, tab);

  // Build rows matching the 31-column C.2 format
  const rows = profiles.map((p) => {
    // Convert Sales Nav URL to public LinkedIn profile URL
    // Expected: https://www.linkedin.com/in/ACwAAAs7MaoB7F4OJDrvvN7ztmz2By_PBs_tV-E
    // Input might be: /sales/lead/ACwAAAs7MaoB7F4OJDrvvN7ztmz2By_PBs_tV-E,NAME_SEARCH,xxx?_ntb=...
    let profileUrl = "";
    if (p.memberUrn) {
      profileUrl = `https://www.linkedin.com/in/${p.memberUrn}`;
    } else if (p.profileUrl) {
      // Try to extract the member URN from a sales lead URL
      const urnMatch = p.profileUrl.match(
        /\/(?:lead|people)\/([A-Za-z0-9_-]+)/
      );
      if (urnMatch) {
        profileUrl = `https://www.linkedin.com/in/${urnMatch[1]}`;
      }
    }

    // Decode the memberUrn to a numeric LinkedIn member ID
    let numericId = "";
    if (p.memberUrn) {
      numericId = decodeMemberUrn(p.memberUrn) || "";
    }

    return [
      "", // Record ID
      p.firstName || "", // First Name
      p.lastName || "", // Last Name
      "", // Domain
      "", // Priority (Company)
      "", // Priority (Role)
      "", // Priority
      "", // Lead Status
      p.company || "", // Company Name
      p.title || "", // Job Title
      profileUrl, // Linkedin Bio (public profile URL)
      "", // First Phone
      "", // First Phone Validation
      "", // Phone Number
      "", // Whatsapp Link
      "", // Mobile Phone Number
      numericId ? `${numericId}@linkedinmembership.id` : "", // Email
      "", // Email Verification
      numericId, // LinkedIn Membership ID (numeric only)
      p.location || "", // Location
      "", // Notes
      "", // Secondary Emails
      "", // Hubspot URL
      "", // Ortus Membership
      "", // Current Tag
      p.isOpenLink ? "Yes" : "No", // Open Profile
      p.isPremium ? "Yes" : "No", // Premium Account
      "", // Linkedin First Connections
      "", // Client Lead Status
      "", // Apollo Contact ID
      "", // Additional email addresses
    ];
  });

  // Append rows to the sheet
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tab}'!A:AE`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  return { success: true, rowsWritten: rows.length };
}

module.exports = { sendToSheet, getServiceAccountEmail, isPermissionError };
