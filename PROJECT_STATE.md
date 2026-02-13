# Preflight Inventory

## Current state observed

- Crawl tooling present: `crawl-site.mjs`, `download-crawl-assets.mjs`
- Crawl artifacts present and complete for rebuild baseline:
  - `crawl-output/site-crawl-report.json`
  - `crawl-output/site-crawl-report.md`
  - `crawl-output/mirror/`
  - `crawl-output/mirror-download-log.json`
- Existing workspace had no valid Astro/site scaffold.
- Existing `README.md` was corrupted/legacy and replaced.

## Partial/legacy/generated artifacts identified

- Legacy mirrored source HTML/assets under `crawl-output/mirror/` (kept as immutable source).
- Auto-generated mirror download log (kept for crawl audit history).
- No usable prior frontend implementation files were found.

## Keep / archive / ignore decisions

- **Keep (source-of-truth):** all files in `crawl-output/`
- **Keep (tooling):** crawl scripts for re-crawl/update workflows
- **Ignore as production source:** mirrored HTML files as direct runtime pages; they are now migration inputs only
- **Production output location:** `docs/` (Astro static build)
