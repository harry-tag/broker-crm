# Broker CRM

A lightweight personal outreach tracker for M&A deal brokers. Runs entirely in the browser — no backend, no login, no build step.

**Live site:** https://harrisonwaddell.github.io/broker-crm/

---

## Features

- Track every broker relationship with name, firm, tier, platform, email, and last-contact date
- Automatic staleness detection — Fresh / Due Soon / Overdue / Never based on configurable per-tier thresholds (default T1=14d, T2=30d, T3=60d)
- Summary stats bar: total brokers, needs outreach, due soon, up to date
- Search by name or firm, filter by tier or status
- Log Today — one click to stamp today's date
- CSV import (deduplicates by name+firm, never overwrites existing contact dates) and CSV export
- Dark / light mode toggle
- All data stored in `localStorage` under `broker-crm-v1` and `broker-crm-thresholds-v1`
- Keyboard shortcut: press `N` to open the Add Broker form, `Esc` to close any modal

---

## Setup (GitHub Pages)

1. Create a new GitHub repo named **`broker-crm`** (public or private — Pages works with both on pro accounts)
2. Push this repo:

   ```bash
   git init
   git add .
   git commit -m "init: broker CRM v1"
   git remote add origin https://github.com/<your-username>/broker-crm.git
   git push -u origin main
   ```

3. In the repo → **Settings → Pages**, set source to **Deploy from branch**, branch `main`, folder `/ (root)`, then save.
4. After ~60 seconds the site will be live at `https://<your-username>.github.io/broker-crm/`

---

## CSV import format

| Column | Required | Notes |
|---|---|---|
| `name` | Yes | |
| `firm` | Yes | |
| `tier` | No | 1, 2, or 3 — defaults to 3 |
| `email` | No | |
| `platform` | No | Axial, Dealsuite, Embrace, etc. |
| `lastContacted` | No | ISO date (YYYY-MM-DD) |
| `notes` | No | |

Re-importing an existing name+firm combination updates all fields **except** `lastContacted`.

---

## Local development

No build required. Just open `index.html` in any browser:

```bash
open index.html        # macOS
start index.html       # Windows
```

Or serve locally:

```bash
npx serve .
```
