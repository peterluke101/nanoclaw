# R&D Council — SKILL.md

## Purpose
Twice daily, the R&D Council (Ares, Tron, Athena, Jarod, Flynn) convenes to review the state of Mission Control and Ares Research Lab, debate improvements, and produce a tight research report for Pete.

## Council Members
- **Ares** — Chair, final voice
- **Tron** — Engineering perspective (what's buildable, what's broken)
- **Athena** — Design/UX perspective (what looks and feels right)
- **Jarod** — Market/content perspective (what's resonating externally)
- **Flynn** — Strategy/ops perspective (what moves the mission forward)

## Schedule
- **10:00 AM PDT** — Morning council
- **9:00 PM PDT** — Evening council

## Process

### Step 1 — Review (5 min)
Read and assess current state:
- What features exist in MC (mission-control/)
- What exists in RL (ares-research-lab/)
- Recent agent activity (memory/YYYY-MM-DD.md)
- What was built/changed in the last 12 hours

### Step 2 — Council Debate (structured)
Each council member weighs in on:
1. **What's working well** — keep and double down
2. **What's broken or weak** — fix or cut
3. **What's missing** — features/data/intel we need
4. **Bold recommendation** — one thing that would create outsized impact

### Standing Agenda Item: Pain Point Compass
Read /Users/macmini/.openclaw/workspace/rd-council/hunt-keywords.md and the latest opportunity hunt report (rd-council/opportunity-hunt-*.md).

Each session, the council must answer:
- Which of the 34 validated pain points aligns best with our current capabilities?
- Is there a pain point we could realistically build a $1M solution for in 90 days?
- Which pain point showed up most in last night's Scout hunt?
- Are we drifting from high-value problems? Re-center if yes.

This is the compass. Every product, every service, every project should trace back to a real, validated, scaled human problem. If it doesn't — cut it.

Debate is real — members can disagree. Ares breaks ties.

### Step 3 — R&D Report (output)
Produce a 2-minute read report in this format:

```
⚗️ R&D COUNCIL REPORT — [Date] [AM/PM]

🔬 REVIEWED
- [bullet: what was assessed]

✅ WORKING
- [what's strong, keep it]

⚠️ NEEDS WORK  
- [what's weak or broken]

💡 NEW IDEAS (debated)
- [Tron]: [engineering idea]
- [Athena]: [design idea]
- [Jarod]: [content/market idea]
- [Flynn]: [strategy idea]

🧭 PAIN POINT COMPASS
- Top pain point match this session: [pain point name + source data]
- Council verdict: [are we solving something real? yes/no/partially]
- $1M opportunity candidate: [which pain point, and how we could own it]

🎯 COUNCIL RECOMMENDATION
[One bold action item — the highest leverage thing to do next]

⚡ ARES DECISION
[What Ares approved from the debate — what gets built/changed]
```

Save report to: /Users/macmini/.openclaw/workspace/rd-council/reports/YYYY-MM-DD-[AM|PM].md

## Delivery
- Append a summary to the morning brief (after MISSION PULSE section)
- Evening report saved to file only — Pete reads at his discretion

## Standing Rules
- Reports must be skimmable in under 2 minutes
- No fluff — every line must be actionable or informative
- Council members speak in their own voice — this is a real debate, not a summary
- If something is bad, say it's bad
- Bold recommendations only — no "maybe consider" language
