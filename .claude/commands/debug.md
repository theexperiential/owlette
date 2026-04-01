---
description: Scientific method debugging — systematic root cause analysis
---

Debug a problem using the scientific method. This prevents the common pitfall of changing random things and hoping something sticks.

## Process

### 1. Observe
Gather facts about the problem:
- What is the exact error message or unexpected behavior?
- When did it start? What changed recently? (`git log --oneline -10`)
- Is it reproducible? Under what conditions?
- What is the expected behavior vs actual behavior?

Read the relevant files and logs. Do NOT hypothesize yet — just collect data.

### 2. Hypothesize
Based on observations, form **ranked hypotheses** (most likely first):

```
## Hypotheses
1. [Most likely cause] — because [evidence from observation]
2. [Second most likely] — because [evidence]
3. [Third most likely] — because [evidence]
```

### 3. Test
For each hypothesis (starting with most likely):
- Design a **minimal test** that would confirm or eliminate it
- Run the test
- Record the result

```
## Testing
### H1: [hypothesis]
- Test: [what you did]
- Result: [CONFIRMED / ELIMINATED — evidence]

### H2: [hypothesis]
- Test: [what you did]
- Result: [CONFIRMED / ELIMINATED — evidence]
```

Stop testing when you find the root cause. Do NOT fix anything yet.

### 4. Diagnose
State the root cause clearly:
```
## Root Cause
[What is actually wrong and why, supported by test evidence]
```

### 5. Fix
Implement the minimal fix for the root cause:
- Fix the actual problem, not the symptom
- Change as little as possible
- Preserve existing patterns and conventions

### 6. Verify
Confirm the fix works:
- Reproduce the original issue — it should be gone
- Check for regressions: run builds (`/build-and-fix` if needed)
- Verify edge cases around the fix

### Report
```
## Debug Complete

**Problem**: [one-line description]
**Root cause**: [what was actually wrong]
**Fix**: [what you changed and why]
**Verified**: [how you confirmed it works]
**Files changed**: [list]
```

## Rules
- Never skip straight to fixing — understand the problem first
- One hypothesis at a time — don't shotgun multiple changes
- If your top 3 hypotheses are all eliminated, step back and re-observe
- If the fix requires changes beyond the immediate bug, flag it as a follow-up rather than scope-creeping the fix
