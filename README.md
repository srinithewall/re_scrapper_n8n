# PropSync Scrapers (housing.com + 99acres)

Scrapes Bengaluru projects from third-party sites and submits them to your RE Projects API as multipart form-data.

## Files

| File | Purpose |
|---|---|
| `scraper.js` | housing.com scraper (HTTP + parser fallbacks) |
| `scraper-puppeteer.js` | 99acres scraper (Puppeteer for JS-rendered pages) |
| `runtime-config.js` | Shared config loader used by both scrapers |
| `scraper.config.json` | Runtime configuration (sources, API, lookback mode) |
| `scraped.json` | Last scraped payload snapshot |
| `submission_report.json` | Last submission result summary |

## Quick start

```bash
node scraper.js --mode=bootstrap
node scraper-puppeteer.js --mode=bootstrap
```

Dry run examples:

```bash
node scraper.js --mode=bootstrap --dry-run
node scraper-puppeteer.js --mode=bootstrap --dry-run
npm run n8n -- --source=99acres --mode=daily --dry-run
```

## Config-based lookback window

Both scripts now read from `scraper.config.json`.

Default modes:
- `bootstrap`: last 90 days
- `daily`: last 24 hours

Switch mode at runtime:

```bash
node scraper.js --mode=daily
node scraper-puppeteer.js --mode=daily
```

Optional runtime override:

```bash
node scraper.js --mode=bootstrap --since-days=90
node scraper-puppeteer.js --mode=daily --since-hours=24
node scraper.js --mode=bootstrap --limit=1 --dry-run
node scraper-puppeteer.js --mode=bootstrap --limit=1 --dry-run
```

## Deduplication, Source Metadata, and Images

- Cross-run/cross-source dedupe is persisted in `submitted_projects_cache.json`.
- Each payload includes `sourceType`, `source`, and `updatedAt`/`sourceUpdatedAt`.
- Developer assignment is resolved from scraped developer/builder names using:
  - `global.developerLookupUrl`
  - `apiDefaults.developerNameMappings`
  - `apiDefaults.fallbackDeveloperId` as a last resort
- Image uploads are capped to `maxImagesPerProject` (default `7`).
- Optional DB dedupe lookup can be enabled with:
  - `global.projectExistsUrlTemplate` (use `{projectName}` placeholder)
  - `global.projectExistsMethod` (default `GET`)

## scraper.config.json example

```json
{
  "mode": "bootstrap",
  "windows": {
    "bootstrap": { "lookbackDays": 90 },
    "daily": { "lookbackHours": 24 }
  },
  "global": {
    "apiUrl": "http://43.204.221.192:8880/api/re/projects",
    "developerLookupUrl": "http://43.204.221.192:8880/api/lookups/developers",
    "outputFile": "scraped.json",
    "reportFile": "submission_report.json",
    "maxImagesPerProject": 7,
    "dedupeStateFile": "submitted_projects_cache.json",
    "projectExistsUrlTemplate": "",
    "projectExistsMethod": "GET"
  },
  "apiDefaults": {
    "constructionStatusid": 5,
    "developerId": 1,
    "fallbackDeveloperId": 1,
    "projectTypeId": 1,
    "defaultZone": "East",
    "defaultCity": "Bengaluru",
    "amenityIds": [5, 6],
    "developerNameMappings": {
      "casagrand builder private limited": 20,
      "sumadhura group": 19
    }
  },
  "sources": {
    "housing": {
      "enabled": true,
      "source": "housing.com",
      "scrapeUrl": "https://housing.com/in/buy/projects-in-bangalore",
      "maxPages": 3,
      "requestDelay": 1500
    },
    "99acres": {
      "enabled": true,
      "source": "99acres.com",
      "scrapeUrl": "https://www.99acres.com/search/property/buy/bangalore?city=20&preference=S&area_unit=1&res_com=R",
      "maxPages": 1,
      "limit": 5,
      "requestDelay": 1500
    }
  }
}
```

## Important note

The lookback window is centralized and available to both scripts (`mode`, `lookbackDays/lookbackHours`, `sinceIso`).
Source-specific date filtering still depends on whether each portal exposes reliable listing timestamps.

## Run From n8n

The easiest way to trigger this project from `n8n` is with an `Execute Command` node.

Recommended command:

```bash
npm run n8n -- --source=99acres --mode=daily
```

Run both sources:

```bash
npm run n8n -- --sources=housing,99acres --mode=bootstrap
```

Dry run:

```bash
npm run n8n -- --source=99acres --mode=daily --dry-run
```

What the wrapper does:
- Runs one or more scrapers sequentially.
- Writes source-specific `scraped` and `report` JSON files under `debug/n8n-runs/...`.
- Prints one final JSON object to `stdout`, which `n8n` can read.

Useful runtime overrides for triggers:

```bash
npm run n8n -- --source=99acres --mode=daily --api-url=http://your-api/api/re/projects
```

Supported overrides:
- `--api-url=...`
- `--output-file=...`
- `--report-file=...`
- `--dedupe-file=...`
- `--max-images=...`

Example n8n flow:
1. `Cron Trigger` or `Webhook Trigger`
2. `Execute Command`
3. Optional `IF` node checking `{{$json["ok"]}}`
4. Optional `Code` / `Set` / notification node

For the `Execute Command` node:
- Command: `npm`
- Arguments: `run n8n -- --source=99acres --mode=daily`
- Working Directory: `C:\SpringBoot\WorkSpace\re-scraper`

Note:
- `housing.com` may block plain HTTP scraping on some runs. If you want the most stable n8n trigger first, start with `--source=99acres`.

## HTTP Trigger Server

If you want `n8n` to call the scraper as a service, run:

```bash
npm run server
```

Default server settings:
- Host: `0.0.0.0`
- Port: `3001`
- Health endpoint: `GET /health`
- Trigger endpoint: `POST /run`

Useful environment variables:
- `SCRAPER_PORT=3001`
- `SCRAPER_HOST=0.0.0.0`
- `SCRAPER_TRIGGER_TOKEN=change-me`
- `SCRAPER_DEFAULT_SOURCE=99acres`
- `SCRAPER_DEFAULT_MODE=daily`
- `SCRAPER_ALLOW_CONCURRENT=false`

Example health check:

```bash
curl http://localhost:3001/health
```

Example trigger request:

```bash
curl -X POST http://localhost:3001/run \
  -H "Content-Type: application/json" \
  -H "x-trigger-token: change-me" \
  -d '{"source":"99acres","mode":"daily","dryRun":true}'
```

Example request body:

```json
{
  "source": "99acres",
  "mode": "daily",
  "dryRun": false,
  "limit": 5,
  "apiUrl": "http://backend:8880/api/re/projects"
}
```

Supported request fields:
- `source`: `99acres` or `housing`
- `sources`: comma-separated string or array, for example `["housing", "99acres"]`
- `mode`: `daily` or `bootstrap`
- `dryRun`: `true` or `false`
- `scrapeOnly`: `true` or `false`
- `submitOnly`: `true` or `false`
- `debug`: `true` or `false`
- `limit`
- `sinceDays`
- `sinceHours`
- `maxImages`
- `apiUrl`
- `outputFile`
- `reportFile`
- `dedupeFile`
- `projectExistsUrl`

Response behavior:
- Returns `200` when all requested sources finish successfully.
- Returns `500` when any source fails.
- Returns `409` when another run is already in progress and concurrency is disabled.
