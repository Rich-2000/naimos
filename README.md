# NAIMOS AMS — Backend Setup Guide

## Project Structure (add `backend/` to your existing root)

```
naimos/                        ← your existing project root
├── index.html                 ← frontend (MODIFIED — add 2 lines)
├── api-client.js              ← NEW: frontend API client (copy from backend/)
├── .env                       ← NEW: copy from backend/.env.example
├── .gitignore                 ← add: .env, node_modules, backend/dist
├── vercel.json                ← REPLACE with the one from backend/
├── package.json               ← keep as-is (or merge scripts below)
│
└── backend/                   ← NEW: entire backend folder
    ├── package.json
    ├── tsconfig.json
    ├── .env.example
    └── src/
        ├── server.ts
        ├── config.ts
        ├── middleware/
        │   ├── logger.ts
        │   └── errorHandler.ts
        └── routes/
            ├── chat.ts
            ├── firms.ts
            ├── sentinel.ts
            ├── gee.ts
            ├── planetary.ts
            └── health.ts
```

---

## Step 1 — Copy files into your naimos root

```bash
# from wherever you saved these files:
cp -r naimos-backend/ /path/to/naimos/backend
cp naimos-backend/api-client.js /path/to/naimos/api-client.js
cp naimos-backend/.env.example /path/to/naimos/.env
cp naimos-backend/vercel.json /path/to/naimos/vercel.json
```

---

## Step 2 — Edit index.html (2 tiny changes)

### Change 1: Remove the old /api/chat.js Vercel function reference
The file `api/chat.js` is now replaced by the TypeScript backend.
You can delete `api/chat.js` — it's no longer needed.

### Change 2: Add api-client.js script tag
Find the closing `</body>` tag in index.html and add ONE line just before it:

```html
  <!-- NAIMOS Backend API Client — replaces all direct third-party API calls -->
  <script src="/api-client.js"></script>
</body>
```

That's it. The api-client.js file overrides the relevant functions from the
inline <script> block (sendAIMessage, fetchFIRMSData, loadSentinelLayer,
fetchGEENDVI, loadPCScenes, etc.) with backend-aware versions.

### Change 3: Remove CORS proxy code from index.html (optional cleanup)
You can optionally remove the `CORS_PROXIES` array and `fetchWithCORSProxy()`
function from the inline <script> block — they are no longer called.
Everything now goes through /api/* on the backend.

---

## Step 3 — Configure environment variables

Edit 
```

---

## Step 4 — Install backend dependencies

```bash
cd /path/to/naimos/backend
npm install
```

---

## Step 5 — Run locally

### Option A: Backend only (frontend served by backend)
```bash
cd /path/to/naimos/backend
npm run dev
# → open http://localhost:3001
```

### Option B: Frontend on its own server + backend separately
```bash
# Terminal 1 — backend
cd /path/to/naimos/backend
npm run dev       # runs on :3001

# Terminal 2 — frontend (e.g. live-server, http-server, etc.)
cd /path/to/naimos
npx live-server   # runs on :8080 or :3000
# api-client.js auto-detects and points to localhost:3001
```

---

## Step 6 — Deploy to Vercel

```bash
cd /path/to/naimos        # deploy from project ROOT, not /backend
vercel deploy
```

Add environment variables in Vercel Dashboard:
→ Project → Settings → Environment Variables
Add all keys from your .env file.

The new vercel.json routes:
- `/api/*` → backend TypeScript server (all APIs, keys stay server-side)
- `/*`     → index.html (SPA)

---

## API Endpoints Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/health` | GET | Check all API key statuses |
| `POST /api/chat` | POST | Gemini AI chat proxy |
| `GET /api/firms?days=7&sensor=VIIRS_SNPP_NRT` | GET | NASA FIRMS CSV proxy |
| `POST /api/sentinel/token` | POST | ESA Sentinel Hub OAuth token |
| `GET /api/sentinel/image?layer=ndvi&region=western` | GET | Sentinel WMS image proxy |
| `GET /api/gee/ndvi?region=western` | GET | GEE NDVI computation + PNG |
| `POST /api/planetary/search` | POST | Planetary Computer STAC search |
| `GET /api/planetary/token/:dataset` | GET | PC SAS token |

---

## How Frontend ↔ Backend Communication Works

```
Browser (index.html + api-client.js)
         │
         │  fetch('/api/chat', { method: 'POST', body: {...} })
         │  fetch('/api/firms?days=7')
         │  fetch('/api/sentinel/image?layer=ndvi&region=western')
         │  fetch('/api/gee/ndvi?region=western')
         │  fetch('/api/planetary/search', { method: 'POST', body: {...} })
         ▼
Node.js/TypeScript Backend (Express)
         │
         ├─→ Gemini API (key from env)
         ├─→ NASA FIRMS API (key from env)
         ├─→ ESA Sentinel Hub (OAuth, key from env)
         ├─→ Google Earth Engine (key from env)
         └─→ Planetary Computer (public + SAS tokens)
```

API keys NEVER leave the server. The browser only sees:
- JSON responses
- PNG image blobs (for Sentinel/GEE imagery)
- CSV text (for FIRMS data)

---

## Troubleshooting

**"Backend health check failed"**
→ Backend not running. `cd backend && npm run dev`

**"GEMINI_API_KEY not configured"**
→ Add it to .env at project root (not backend/.env)

**Sentinel image loads blank**
→ Trial may be expired. The backend will return a 502 with a helpful message.
→ Use the Planetary Computer tab instead (free, no auth).

**GEE returns 403**
→ Enable Earth Engine API: console.cloud.google.com → APIs → Earth Engine API → Enable

**FIRMS returns 401**
→ Check your MAP_KEY at firms.modaps.eosdis.nasa.gov

---

## What Changed vs The Old Setup

| Feature | Before | After |
|---------|--------|-------|
| Gemini AI key | Exposed in browser JS | Server env variable |
| FIRMS data | 3 CORS proxy fallbacks | Direct server fetch |
| Sentinel auth | Complex browser OAuth | Single server token |
| Sentinel imagery | CORS canvas tricks | Clean image blob proxy |
| GEE key | Exposed in browser JS | Server env variable |
| Planetary tokens | Browser fetch to PC | Server-side + signing |
| Error messages | Generic proxy errors | Specific actionable hints |
