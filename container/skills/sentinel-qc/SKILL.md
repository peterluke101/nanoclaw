---
name: sentinel-qc
description: >
  Production-grade QC (Quality Control) system for AI agent output. Runs automated checks across
  4 domains: PDF QC (blank space, orphaned headings, duplicate content, AI detection per page),
  Posts QC (character count, hashtags, URL validity, AI language detection, duplicates),
  Code QC (13 checks: TypeScript compilation, ESLint, npm audit, security headers, port conflicts,
  lighthouse, bundle size, unused deps, API validation, hardcoded secrets, console logs, TODOs, build),
  and Ops QC (25 tests across services, pages, funnels, rendering, buttons).
  Includes a 6-method AI Detection Engine (perplexity, burstiness, vocabulary richness, structure
  uniformity, readability flatness, AI fingerprints) returning a 0-1 score.
  Use when: (1) validating PDF builds before delivery, (2) checking social media posts before publishing,
  (3) running code quality checks on a project, (4) testing live site operations,
  (5) detecting AI-generated text in any content, (6) any QC gate before deliverables reach humans.
  Trigger on: "run QC", "quality check", "check this PDF", "AI detection", "code QC",
  "ops test", "post check", "sentinel", "QC gate", "validate before delivery".
---

# Sentinel QC

Quality control system for AI agent output. Wraps the PDF Sentinel app APIs running at `http://localhost:3000`.

## Prerequisites

PDF Sentinel must be running:
```bash
cd /Users/macmini/.openclaw/workspace/pdf-forge && npm run dev
```
Default: `http://localhost:3000`. Override with `SENTINEL_URL` env var.

## Quick Commands

Run all QC types via the shell script:

```bash
# PDF QC — build and score a guide
bash scripts/run-qc.sh pdf <guide-key> [variant]
# guide-key: trt, sarms, nootropics, longevity, supplement
# variant: full (default), quick

# Posts QC — check all loaded posts
bash scripts/run-qc.sh posts

# Code QC — run 13 checks on a project
bash scripts/run-qc.sh code <project-dir>

# Ops QC — run 25 live site tests
bash scripts/run-qc.sh ops

# AI Detection — score text from stdin
echo "Your text here" | bash scripts/run-qc.sh ai

# Full sweep — all checks
bash scripts/run-qc.sh all <guide-key>
```

## API Endpoints (Direct)

When calling APIs directly instead of the script:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/build` | POST | Build PDF and run page-by-page QC (blank space, orphans, AI detection) |
| `/api/posts/qc` | GET | QC all social media posts |
| `/api/code/qc` | POST | Run 13 code checks on a project. Body: `{"project":"<dir-name>"}` |
| `/api/ops/qc` | GET | Run 25 ops tests against live sites |

### PDF Build + QC Request

```bash
curl -X POST http://localhost:3000/api/build \
  -H "Content-Type: application/json" \
  -d '{"guide":"trt","variant":"full","qc":true}'
```

Response includes per-page results: `score`, `blankRatio`, `flags[]`, `aiScore`, `wordCount`.

### Code QC Request

```bash
curl -X POST http://localhost:3000/api/code/qc \
  -H "Content-Type: application/json" \
  -d '{"project":"pdf-forge"}'
```

Response: `overallScore` (0-100) plus individual check results for all 13 checks.

## Interpreting Results

### Scores
- **90-100**: Ship it
- **70-89**: Review flagged items, fix warnings
- **50-69**: Significant issues, fix before delivery
- **Below 50**: Do not ship

### AI Detection Score (0-1)
- **< 0.3**: Human-written
- **0.3-0.7**: Mixed / needs review
- **> 0.7**: AI-generated, run through humanizer

### Code QC Checks (13 total)
`typescript` · `build` · `eslint` · `secrets` · `consoleLogs` · `todos` · `npmAudit` · `securityHeaders` · `portConflicts` · `lighthouse` · `bundleSize` · `unusedDeps` · `apiValidation`

Each check returns: `score` (0-100), `status` (pass/warn/fail/skip), `details[]`.

## Workflow Integration

Standard QC gate before any deliverable:

1. Build/prepare the deliverable
2. Run `bash scripts/run-qc.sh <type>` against it
3. If score < 70 or any `fail` status → fix and re-run
4. If AI score > 0.7 → run content through humanizer skill
5. Only deliver after all checks pass

For PDF delivery, always run PDF QC + AI detection. For code projects, run Code QC before any PR or deployment.
