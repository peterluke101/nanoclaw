# Skill: morning-brief

## Purpose
Deliver Pete's daily command briefing via Telegram at 5:00 AM PDT.

## Prerequisites
- Read `/Users/macmini/.openclaw/workspace/MEMORY.md`
- Read `/Users/macmini/.openclaw/workspace/memory/[TODAY].md` (today's date)
- Read `/Users/macmini/.openclaw/workspace/memory/[YESTERDAY].md` if it exists

## Steps
1. Read MEMORY.md for current project status, decisions, and team activity
2. Read today's and yesterday's daily memory files for recent context
3. Identify what was accomplished in the last 24h
4. Identify what is currently waiting on Pete's approval
5. Identify what is actively in progress today
6. Check Athena utilization — is she fully loaded? Suggest tasks if not
7. Note any marketing updates relevant to Peptide Compass
8. Compose brief using the Output Format below
9. Send via Telegram to Pete (channel: telegram)

## Output Format
```
☀️ MORNING BRIEF — [Day, Date]

✅ ACCOMPLISHED YESTERDAY
- [bullet: what was completed]

⏳ WAITING ON YOUR APPROVAL
- [bullet: decisions Pete needs to make]

🔥 ON THE PLATE TODAY
- [bullet: what team is working on]

💡 TEAM NEEDS / IMPROVEMENTS
- [bullet: blockers, gaps, suggestions]
- Athena: [utilization status + suggested tasks if idle]
- Marketing: [low-cost opportunity or update]

📊 MISSION PULSE: [one line — how today moves toward massive profits]
```

## Validation
- Brief must have all 5 sections
- Must not be empty — if nothing happened, note that and suggest a focus
- Telegram send must succeed

## Edge Cases
- If memory files don't exist: note "No prior activity logged" and focus on what's queued
- If Telegram fails: log error to `/Users/macmini/.openclaw/workspace/memory/cron-errors.log`
- Never fabricate completed tasks — only report what's in memory files

## Quality Gates
- No fluff, no filler — Pete reads this in under 60 seconds
- Actionable items only in "Waiting on Approval"
- Athena utilization always addressed
