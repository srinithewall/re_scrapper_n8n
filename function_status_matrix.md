# Function Status Matrix — [scraper-puppeteer-housing.js](file:///c:/SpringBoot/WorkSpace/re-scraper/scraper-puppeteer-housing.js)

This matrix tracks the health of all core components in the scraper. It is updated after every significant change to prevent regressions.

| Function / Component | Step Ref | Status | Description |
| :--- | :--- | :--- | :--- |
| **Logic Core** | | | |
| [checkImageSize](file:///c:/SpringBoot/WorkSpace/re-scraper/scraper-puppeteer-housing.js#45-72) | Step 3 | ✅ Working | Verified >30KB head/get check. |
| [downloadImage](file:///c:/SpringBoot/WorkSpace/re-scraper/scraper-puppeteer-housing-deep.js#42-61) | Step 4 | ✅ Working | Standard buffer download with 30KB min. |
| [extractFromNextData](file:///c:/SpringBoot/WorkSpace/re-scraper/scraper.js#297-334) | Step 5 | ✅ Working | Recursive JSON extraction logic. |
| [deriveUnitTypes](file:///c:/SpringBoot/WorkSpace/re-scraper/scraper-puppeteer-housing.js#200-216) | Step 5 | ✅ Working | Maps BHK configurations to schema. |
| [extractMedia](file:///c:/SpringBoot/WorkSpace/re-scraper/scraper.js#403-430) | Step 5 | ✅ Working | Captures images and YouTube links. |
| [extractAmenities](file:///c:/SpringBoot/WorkSpace/re-scraper/scraper-puppeteer-housing-deep.js#258-274) | Step 5 | ✅ Working | Captures raw label strings for lookups. |
| [buildFormFields](file:///C:/SpringBoot/WorkSpace/re-scraper-ver1/scraper.js#359-392) | Step 6 | ✅ Working | Maps extracted data to Multi-part form. |
| **Submission Gate** | | | |
| `Local Dedupe Check` | Step 9.1 | ✅ Working | Checks [submitted_projects_cache.json](file:///c:/SpringBoot/WorkSpace/re-scraper/submitted_projects_cache.json). |
| `30KB Verification` | Step 9.2 | ✅ Working | Filters individual image URLs. |
| `Project Skip Logic` | Step 11 | ✅ Working | Aborts project if 0 valid images found. |
| `Dynamic Lookups` | Step 10 | ✅ Working | Resolves/Creates Devs/Amenities via API. |
| `JSON Audit Log` | Step 12 | ✅ Working | Prints full payload before submission. |
| **Removed / Replaced** | | | |
| [parsePrice](file:///C:/SpringBoot/WorkSpace/re-scraper-ver1/scraper-puppeteer.js#102-115) | - | 🗑️ Removed | No longer needed for Housing JSON source. |
| [getZone](file:///c:/SpringBoot/WorkSpace/re-scraper/scraper-puppeteer.js#116-123) | - | 🗑️ Removed | Using `defaultZone` from config. |
| [localityFromSlug](file:///c:/SpringBoot/WorkSpace/re-scraper-ver1/scraper-puppeteer.js#124-136)| - | 🗑️ Removed | Replaced by direct JSON path extraction. |

---
**Last Updated**: 2026-03-15
**Validated By**: Antigravity (Dry-Run 1.0)
