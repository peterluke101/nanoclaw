#!/usr/bin/env bash
# Sentinel QC — Quality Control runner for AI agent output
# Wraps the PDF Sentinel API endpoints
set -euo pipefail

SENTINEL_URL="${SENTINEL_URL:-http://localhost:3000}"
BOLD='\033[1m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  cat <<EOF
${BOLD}Sentinel QC${NC} — Quality control for AI agent output

Usage:
  $(basename "$0") pdf <guide-key> [variant]   Build + QC a PDF guide
  $(basename "$0") posts                       QC all social media posts
  $(basename "$0") code <project-dir>          Run 13 code checks on a project
  $(basename "$0") ops                         Run 25 ops tests on live sites
  $(basename "$0") ai                          AI detection on stdin text
  $(basename "$0") all <guide-key>             Full sweep (PDF + Posts + Code + Ops)

Guide keys: trt, sarms, nootropics, longevity, supplement
Variants: full (default), quick

Environment:
  SENTINEL_URL   Base URL (default: http://localhost:3000)
EOF
  exit 1
}

check_server() {
  if ! curl -sf "${SENTINEL_URL}" -o /dev/null --connect-timeout 3 2>/dev/null; then
    echo -e "${RED}ERROR: PDF Sentinel not running at ${SENTINEL_URL}${NC}"
    echo "Start it: cd /Users/macmini/.openclaw/workspace/pdf-forge && npm run dev"
    exit 1
  fi
}

print_header() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

score_color() {
  local score=$1
  if (( score >= 90 )); then echo -e "${GREEN}${score}${NC}"
  elif (( score >= 70 )); then echo -e "${YELLOW}${score}${NC}"
  else echo -e "${RED}${score}${NC}"
  fi
}

# ──────────────────────────────────────────────────────────
# PDF QC
# ──────────────────────────────────────────────────────────
run_pdf_qc() {
  local guide="${1:-trt}"
  local variant="${2:-full}"
  check_server
  print_header "PDF QC: ${guide} (${variant})"

  echo "Building and analyzing..."
  local response
  response=$(curl -sf -X POST "${SENTINEL_URL}/api/build" \
    -H "Content-Type: application/json" \
    -d "{\"guide\":\"${guide}\",\"variant\":\"${variant}\",\"qc\":true}" \
    --max-time 120)

  if [ $? -ne 0 ] || [ -z "$response" ]; then
    echo -e "${RED}FAIL: Build request failed${NC}"
    return 1
  fi

  # Parse results
  local total_pages avg_score fail_count
  total_pages=$(echo "$response" | jq -r '.pages | length // 0')
  avg_score=$(echo "$response" | jq -r '[.pages[].score // 0] | add / length * 100 | floor // 0')
  fail_count=$(echo "$response" | jq -r '[.pages[] | select(.score < 0.5)] | length // 0')

  echo -e "Pages: ${BOLD}${total_pages}${NC}"
  echo -e "Average Score: $(score_color "$avg_score")/100"
  echo -e "Failing Pages: ${fail_count}"

  # Show flagged pages
  echo "$response" | jq -r '.pages[] | select(.flags | length > 0) |
    "  Page \(.pageNum): score=\(.score) blank=\(.blankRatio) ai=\(.aiScore // "n/a") flags=\(.flags | join(", "))"' 2>/dev/null || true

  # Overall verdict
  echo ""
  if (( avg_score >= 90 )); then
    echo -e "${GREEN}✓ PDF QC PASSED${NC} — Ready to ship"
  elif (( avg_score >= 70 )); then
    echo -e "${YELLOW}⚠ PDF QC WARNING${NC} — Review flagged pages"
  else
    echo -e "${RED}✗ PDF QC FAILED${NC} — Fix issues before delivery"
  fi
}

# ──────────────────────────────────────────────────────────
# Posts QC
# ──────────────────────────────────────────────────────────
run_posts_qc() {
  check_server
  print_header "Posts QC"

  local response
  response=$(curl -sf "${SENTINEL_URL}/api/posts/qc" --max-time 30)

  if [ -z "$response" ]; then
    echo -e "${RED}FAIL: Posts QC request failed${NC}"
    return 1
  fi

  local total pass warn fail
  total=$(echo "$response" | jq -r '.summary.total // 0')
  pass=$(echo "$response" | jq -r '.summary.pass // 0')
  warn=$(echo "$response" | jq -r '.summary.warn // 0')
  fail=$(echo "$response" | jq -r '.summary.fail // 0')

  echo -e "Total Posts: ${BOLD}${total}${NC}"
  echo -e "Pass: ${GREEN}${pass}${NC}  Warn: ${YELLOW}${warn}${NC}  Fail: ${RED}${fail}${NC}"

  # Show failing posts
  echo "$response" | jq -r '.results[] | select(.flags | length > 0) |
    "  \(.id): \(.flags | map(.message) | join("; "))"' 2>/dev/null | head -20 || true

  echo ""
  if [ "$fail" -eq 0 ] && [ "$warn" -eq 0 ]; then
    echo -e "${GREEN}✓ Posts QC PASSED${NC}"
  elif [ "$fail" -eq 0 ]; then
    echo -e "${YELLOW}⚠ Posts QC WARNING${NC} — ${warn} posts need review"
  else
    echo -e "${RED}✗ Posts QC FAILED${NC} — ${fail} posts have errors"
  fi
}

# ──────────────────────────────────────────────────────────
# Code QC
# ──────────────────────────────────────────────────────────
run_code_qc() {
  local project="${1:?Project directory required}"
  check_server
  print_header "Code QC: ${project}"

  # Extract just the directory name for the API
  local project_name
  project_name=$(basename "$project")

  echo "Running 13 checks..."
  local response
  response=$(curl -sf -X POST "${SENTINEL_URL}/api/code/qc" \
    -H "Content-Type: application/json" \
    -d "{\"project\":\"${project_name}\"}" \
    --max-time 180)

  if [ -z "$response" ]; then
    echo -e "${RED}FAIL: Code QC request failed${NC}"
    return 1
  fi

  local overall_score
  overall_score=$(echo "$response" | jq -r '.overallScore // 0 | floor')

  echo -e "Overall Score: $(score_color "$overall_score")/100"
  echo ""

  # Show each check
  echo "$response" | jq -r '.checks | to_entries[] |
    "  \(if .value.status == "pass" then "✓" elif .value.status == "warn" then "⚠" elif .value.status == "fail" then "✗" else "○" end) \(.key): \(.value.score)/100 [\(.value.status)]"' 2>/dev/null || true

  # Show details for failing checks
  echo ""
  echo "$response" | jq -r '.checks | to_entries[] | select(.value.status == "fail") |
    "  FAIL \(.key): \(.value.details[:3] | join("; "))"' 2>/dev/null || true

  echo ""
  if (( overall_score >= 90 )); then
    echo -e "${GREEN}✓ Code QC PASSED${NC} — Ship it"
  elif (( overall_score >= 70 )); then
    echo -e "${YELLOW}⚠ Code QC WARNING${NC} — Review warnings"
  else
    echo -e "${RED}✗ Code QC FAILED${NC} — Fix failures before deploy"
  fi
}

# ──────────────────────────────────────────────────────────
# Ops QC
# ──────────────────────────────────────────────────────────
run_ops_qc() {
  check_server
  print_header "Ops QC (25 tests)"

  local response
  response=$(curl -sf "${SENTINEL_URL}/api/ops/qc" --max-time 120)

  if [ -z "$response" ]; then
    echo -e "${RED}FAIL: Ops QC request failed${NC}"
    return 1
  fi

  local total pass warn fail overall
  total=$(echo "$response" | jq -r '.summary.total // 0')
  pass=$(echo "$response" | jq -r '.summary.pass // 0')
  warn=$(echo "$response" | jq -r '.summary.warn // 0')
  fail=$(echo "$response" | jq -r '.summary.fail // 0')
  overall=$(echo "$response" | jq -r '.summary.overallScore // 0 | floor')

  echo -e "Tests: ${BOLD}${total}${NC}  Score: $(score_color "$overall")/100"
  echo -e "Pass: ${GREEN}${pass}${NC}  Warn: ${YELLOW}${warn}${NC}  Fail: ${RED}${fail}${NC}"

  # Show by category
  echo ""
  echo "$response" | jq -r '.summary.byCategory | to_entries[] |
    "  \(.key): \(.value.pass)/\(.value.total) pass (avg \(.value.avgScore | floor))"' 2>/dev/null || true

  # Show failures
  echo "$response" | jq -r '.results[] | select(.status == "fail") |
    "  ✗ \(.name): \(.error // "failed") [\(.url)]"' 2>/dev/null | head -15 || true

  echo ""
  if (( overall >= 90 )); then
    echo -e "${GREEN}✓ Ops QC PASSED${NC}"
  elif (( overall >= 70 )); then
    echo -e "${YELLOW}⚠ Ops QC WARNING${NC}"
  else
    echo -e "${RED}✗ Ops QC FAILED${NC}"
  fi
}

# ──────────────────────────────────────────────────────────
# AI Detection (stdin)
# ──────────────────────────────────────────────────────────
run_ai_detect() {
  check_server
  print_header "AI Detection"

  local text
  if [ -t 0 ]; then
    echo "Enter text (Ctrl+D when done):"
  fi
  text=$(cat)

  if [ -z "$text" ]; then
    echo -e "${RED}No text provided${NC}"
    return 1
  fi

  # Use the posts QC endpoint with a synthetic post for AI detection,
  # or call the build endpoint. For standalone AI detection, we POST
  # to a lightweight endpoint.
  local escaped_text
  escaped_text=$(echo "$text" | jq -Rs .)

  local response
  response=$(curl -sf -X POST "${SENTINEL_URL}/api/posts/qc" \
    -H "Content-Type: application/json" \
    -d "{\"text\":${escaped_text}}" \
    --max-time 30 2>/dev/null)

  # If the posts endpoint doesn't support direct text, show the text stats
  if [ -z "$response" ] || echo "$response" | jq -e '.error' &>/dev/null; then
    # Fallback: count basic stats locally
    local words chars sentences
    words=$(echo "$text" | wc -w | tr -d ' ')
    chars=$(echo -n "$text" | wc -c | tr -d ' ')
    sentences=$(echo "$text" | grep -oE '[.!?]' | wc -l | tr -d ' ')
    echo -e "Words: ${words}  Chars: ${chars}  Sentences: ${sentences}"
    echo -e "${YELLOW}Note: For full AI detection scores, use the PDF Sentinel web UI${NC}"
    echo -e "Or run PDF QC which includes per-page AI scoring."
  else
    echo "$response" | jq -r '.' 2>/dev/null || echo "$response"
  fi
}

# ──────────────────────────────────────────────────────────
# Full Sweep
# ──────────────────────────────────────────────────────────
run_all() {
  local guide="${1:-trt}"
  run_pdf_qc "$guide"
  echo ""
  run_posts_qc
  echo ""
  run_code_qc "pdf-forge"
  echo ""
  run_ops_qc
  echo ""
  print_header "FULL SWEEP COMPLETE"
}

# ──────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────
case "${1:-}" in
  pdf)   run_pdf_qc "${2:-}" "${3:-full}" ;;
  posts) run_posts_qc ;;
  code)  run_code_qc "${2:?Usage: $0 code <project-dir>}" ;;
  ops)   run_ops_qc ;;
  ai)    run_ai_detect ;;
  all)   run_all "${2:-trt}" ;;
  *)     usage ;;
esac
