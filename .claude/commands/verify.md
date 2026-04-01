---
description: Verify completed work against plan success criteria
---

Verify that completed work meets the plan's success criteria. Run this after /execute or /next completes all tasks.

## Process

### Step 1: Load Plan

Read all three files from `dev/active/[task-name]/`:
- `plan.md` — for success criteria and approach
- `tasks.md` — for task-level done-when criteria
- `context.md` — for key decisions and integration points

### Step 2: Build Check

Run both builds and capture output:
```bash
cd web && npx tsc --noEmit 2>&1
```
```bash
cd agent && python -m py_compile src/*.py 2>&1
```

### Step 3: Task-Level Verification

For each completed task, verify its **Done when** criteria:
- Read the files the task modified
- Check that the described changes are actually present and correct
- Flag any task where the criteria aren't fully met

### Step 4: Plan-Level Verification

Check the plan's overall **Success Criteria**:
- Are all functional requirements met?
- Do the pieces integrate correctly?
- Are there any obvious gaps between what was planned and what was built?

### Step 5: Regression Check

Look for common issues:
- Unused imports or variables introduced
- Missing error handling on new code paths
- Type errors or lint issues
- Broken patterns (e.g., direct Firestore calls instead of hooks)

### Step 6: Report

```
## Verification Report

### Build
- Web (TypeScript): [PASS/FAIL — details if fail]
- Agent (Python): [PASS/FAIL — details if fail]

### Task Verification
- [x] Task 1.1: [PASS] — [brief note]
- [x] Task 1.2: [PASS] — [brief note]
- [x] Task 2.1: [FAIL] — [what's wrong]

### Success Criteria
- [x] [Criterion 1]: Met
- [ ] [Criterion 2]: Not met — [what's missing]

### Issues Found
1. [Issue description + file:line + suggested fix]
2. [...]

### Verdict: [PASS / PASS WITH NOTES / FAIL]
[Summary — what's good, what needs fixing]
```

If FAIL: list exactly what needs to be fixed. The user can then address issues manually or run /next on remaining work.

If PASS: suggest archiving the dev docs:
```bash
mv dev/active/[task-name] dev/completed/[task-name]
```
