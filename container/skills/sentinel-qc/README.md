# Sentinel QC

**Production-grade quality control for AI agent output.**

Stop shipping garbage. Sentinel QC catches what humans miss — blank PDF pages, AI-sounding copy, broken code, dead endpoints — before your deliverables reach clients.

## What It Does

Four QC domains, one command:

### PDF QC
Builds PDFs from markdown via WeasyPrint, then scores every page:
- Blank space detection (catches empty/near-empty pages)
- Orphaned heading detection (headings stranded at page bottoms)
- Duplicate content flagging
- Per-page AI detection scoring
- Word count and content density analysis

### Posts QC
Validates social media posts before publishing:
- Character count limits per platform
- Hashtag count and formatting
- URL validity checking
- AI language pattern detection (buzzwords, hedging phrases, AI openers)
- Duplicate post detection
- CTA presence verification

### Code QC — 13 Automated Checks
- TypeScript compilation
- Production build verification
- ESLint errors and warnings
- Hardcoded secrets detection
- Console.log cleanup
- TODO/FIXME audit
- npm audit (critical/high/moderate/low vulnerabilities)
- Security headers verification
- Port conflict detection
- Lighthouse performance scores
- Bundle size analysis
- Unused dependency detection
- API endpoint validation

### Ops QC — 25 Live Tests
Tests across 5 categories:
- **Services**: API health, response times, status codes
- **Pages**: Landing pages, content pages load correctly
- **Funnels**: Checkout flows, signup flows respond
- **Rendering**: Pages render expected content
- **Buttons**: CTAs and interactive elements present in DOM

### AI Detection Engine
6 statistical methods, no external APIs, no ML models — pure TypeScript analysis:
1. **Perplexity proxy** — bigram predictability and filler phrase density
2. **Burstiness** — sentence length variance (AI writes flat, humans burst)
3. **Vocabulary richness** — type-token ratio, hapax legomena, word length distribution
4. **Structure uniformity** — sentence starter patterns, punctuation density, transition phrases
5. **Readability flatness** — Flesch-Kincaid variance across paragraphs
6. **AI fingerprints** — hedging phrases, buzzwords, balanced constructions, em dash overuse

Returns a 0-1 score: < 0.3 human, 0.3-0.7 mixed, > 0.7 AI-generated.

## Stats

- **96% AI detection accuracy** on tested content
- **13 code quality checks** per project
- **25 ops tests** per sweep
- **Battle-tested** on 10+ PDF guides in production
- **Zero external API dependencies** for AI detection

## Installation

Install via ClawHub:
```bash
clawhub install sentinel-qc
```

### Prerequisites
- PDF Sentinel app running (`npm run dev` in the pdf-forge directory)
- `curl` and `jq` available in PATH
- Node.js 18+

## Usage

### From an OpenClaw agent
The skill auto-triggers on QC-related requests. The agent reads SKILL.md and runs the appropriate checks.

### CLI
```bash
# PDF quality check
bash scripts/run-qc.sh pdf trt full

# Social media post check
bash scripts/run-qc.sh posts

# Code quality (13 checks)
bash scripts/run-qc.sh code my-project

# Live ops testing (25 tests)
bash scripts/run-qc.sh ops

# AI detection on text
echo "Your text here" | bash scripts/run-qc.sh ai

# Full sweep — everything
bash scripts/run-qc.sh all trt
```

### Integrate into workflows
Use as a QC gate: run before any delivery, PR merge, or deployment. If the score is below 70 or any check fails, block the deliverable until fixed.

## Pricing

**$49** — one-time purchase, unlimited use.

Includes all 4 QC domains, the AI detection engine, the shell runner script, and future updates.

## License

Proprietary. Single-team license per purchase.
