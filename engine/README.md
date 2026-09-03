# Sales Nav Cloud Scraper

A cloud-based LinkedIn Sales Navigator scraper with a web UI. Replaces the Chrome extension — runs on a server so you can close your laptop and it keeps going.

## What It Does

- **Single Scrape** — paste a Sales Nav search URL, get all results exported to Google Sheets
- **Batch Scrape** — paste multiple URLs, each gets its own tab in your sheet
- **Live Progress** — real-time page/profile counts via WebSocket
- **Pause / Resume / Stop** — full control over running jobs
- **Anti-detection** — random delays, real browser fingerprint, session persistence
- **Direct Sheets API** — writes to Google Sheets directly, no Apps Script middleman

## Tech Stack

| Component | Tool |
|-----------|------|
| Language | Node.js |
| Browser automation | Playwright (Chromium) |
| Web server | Express |
| Real-time updates | WebSocket |
| Sheets integration | Google Sheets API (service account) |
| Hosting | Railway ($5/month) |

---

## Local Setup

### 1. Install dependencies

```bash
npm install
npm run install-browser
```

### 2. Set up Google Sheets API (one-time, ~5 minutes)

You need a Google Cloud service account so the scraper can write to your sheets. Here's how:

#### Step A — Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click **Select a project** → **New Project**
3. Name it anything (e.g. "salesnav-scraper") → **Create**

#### Step B — Enable the Sheets API

1. In your project, go to **APIs & Services** → **Library**
2. Search for **Google Sheets API**
3. Click it → **Enable**

#### Step C — Create a service account

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **Service Account**
3. Name it anything (e.g. "scraper") → **Done**
4. Click on the service account you just created
5. Go to the **Keys** tab → **Add Key** → **Create new key** → **JSON** → **Create**
6. A `.json` file downloads — this is your service account key

#### Step D — Add it to the project

Move the downloaded file to your project folder and rename it:

```bash
mv ~/Downloads/your-project-abc123.json ./service-account.json
```

#### Step E — Share your Google Sheet with the service account

Open your Google Sheet → click **Share** → paste the service account email
(it looks like `scraper@your-project.iam.gserviceaccount.com`)
Give it **Editor** access → **Send**

That's it. The scraper can now write to that sheet.

### 3. Configure environment

```bash
cp .env.example .env
```

The defaults work if your `service-account.json` is in the project root. No other config needed.

### 4. Log into LinkedIn (one-time)

```bash
npm run login
```

A Chrome window opens. Log into LinkedIn, complete any 2FA, then press ENTER in the terminal. Your session is saved to `./session/`.

### 5. Start the app

```bash
npm start
```

Open http://localhost:3000 in your browser. You'll see the web UI.

---

## Deploy to Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "initial"
git remote add origin YOUR_GITHUB_REPO
git push -u origin main
```

> **Important:** `service-account.json` and `session/` are in `.gitignore` — they won't be pushed (which is correct for security).

### 2. Create a Railway project

- Go to https://railway.app
- New Project → Deploy from GitHub Repo
- Select your repository

### 3. Set environment variables

In Railway dashboard → Variables:

```
HEADLESS=true
PORT=3000
```

For the service account, paste the entire JSON file content as an env var:

```
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"...","client_email":"...","..."}
```

(Open your `service-account.json`, copy the whole thing, paste it as the value.)

### 4. Upload your LinkedIn session

Your `./session/` folder contains your LinkedIn cookies. You need to get it onto Railway:

**Option A — Volume mount (recommended)**
- Add a volume in Railway dashboard
- Mount it at `/app/session`
- Copy your local session files to the volume via `railway run`

**Option B — Include in deploy (simpler but less secure)**
- Temporarily remove `session/` from `.gitignore`
- Push it with your code (make sure the repo is **private**)
- Re-add `session/` to `.gitignore` after

### 5. Add a start command

Railway should auto-detect `npm start`. If not, set the start command to:

```
npm run install-browser && npm start
```

### 6. Access your app

Railway gives you a public URL like `https://salesnav-scraper-production.up.railway.app`. Open it — that's your scraper UI.

---

## Usage

### Single Scrape
1. Open the web UI
2. Paste your Sales Navigator search URL
3. Paste your Google Sheet URL
4. Set a tab name
5. Click **Start Scraping**
6. Watch progress in the Jobs tab

### Batch Scrape
1. Switch to the Batch tab
2. Paste multiple Sales Nav URLs (one per line)
3. Provide the destination sheet URL
4. Each URL gets its own tab: "Results 1", "Results 2", etc.
5. Click **Start Batch**

### Settings
- **Slow Mode** — increases delay between pages from 2-4s to 6-10s
- **Google Sheets status** — shows whether the service account is connected

---

## How Sheets Access Works

```
Your server (Node.js)
    | uses service account credentials
Google Sheets API
    | writes directly
Your Google Sheet
```

No middleman. No Apps Script. The service account acts like a dedicated Google user that only has access to sheets you explicitly share with it.

**To use a new sheet:** just share it with the service account email address. That's all — no code changes needed.

---

## File Structure

```
salesnav-cloud-scraper/
├── server.js              # Express + WebSocket server
├── browser.js             # Playwright browser manager
├── scraper.js             # Core scraping logic
├── interceptor.js         # LinkedIn API response interceptor
├── sheets.js              # Google Sheets API direct writer
├── queue.js               # Job queue manager
├── login.js               # One-time LinkedIn login helper
├── public/
│   └── index.html         # Web UI (single-page app)
├── session/               # LinkedIn session cookies (created after login)
├── service-account.json   # Google Cloud credentials (you create this)
├── .env.example           # Environment variable template
├── Dockerfile             # Railway deployment
├── package.json
└── README.md
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "No service account found" | Place `service-account.json` in project root, or set `GOOGLE_SERVICE_ACCOUNT_JSON` env var |
| "Spreadsheet not found" | You need to share the Google Sheet with the service account email |
| Scraping stops | LinkedIn session may have expired. Run `npm run login` again |
| "Throttle detected" | LinkedIn is rate-limiting you. Enable Slow Mode and reduce volume |

---

## Important Notes

- **Session expiry**: LinkedIn sessions last weeks but do expire. If scraping stops working, run `npm run login` again locally and re-upload the session.
- **Rate limits**: LinkedIn may throttle you if you scrape too aggressively. Use Slow Mode for large batches.
- **Account risk**: Running from a cloud server IP increases detection risk. Consider using a residential proxy for high volumes.
- **Sheet sharing**: Every Google Sheet you want to write to must be shared with the service account email. This is a one-time step per sheet.
