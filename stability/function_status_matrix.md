# Function Status Matrix — `scraper-puppeteer-housing.js`

This matrix tracks the health of all core components in the scraper. It is updated after every significant change to prevent regressions.

| Function / Component | Step Ref | Status | Description |
| :--- | :--- | :--- | :--- |
| **Logic Core** | | | |
| `checkImageSize` | Step 3 | ✅ Working | Verified >30KB head/get check. |
| `downloadImage` | Step 4 | ✅ Working | Standard buffer download with 30KB min. |
| `extractFromNextData` | Step 5 | ✅ Working | Recursive JSON extraction logic. |
| `deriveUnitTypes` | Step 5 | ✅ Working | Maps BHK configurations to schema. |
| `extractMedia` | Step 5 | ✅ Working | Captures images and YouTube links. |
| `extractAmenities` | Step 5 | ✅ Working | Captures raw label strings for lookups. |
| `buildFormFields` | Step 6 | ✅ Working | Maps extracted data to Multi-part form. |
| **Submission Gate** | | | |
| `Local Dedupe Check` | Step 9.1 | ✅ Working | Checks `submitted_projects_cache.json`. |
| `30KB Verification` | Step 9.2 | ✅ Working | Filters individual image URLs. |
| `Project Skip Logic` | Step 11 | ✅ Working | Aborts project if 0 valid images found. |
| `Dynamic Lookups` | Step 10 | ✅ Working | Resolves/Creates Devs/Amenities via API. |
| `JSON Audit Log` | Step 12 | ✅ Working | Prints full payload before submission. |
| **Removed / Replaced** | | | |
| `parsePrice` | - | 🗑️ Removed | No longer needed for Housing JSON source. |
| `getZone` | - | 🗑️ Removed | Using `defaultZone` from config. |
| `localityFromSlug`| - | 🗑️ Removed | Replaced by direct JSON path extraction. |

---
**Last Updated**: 2026-03-15
**Validated By**: Antigravity (Dry-Run 1.0)
