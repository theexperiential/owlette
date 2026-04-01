---
description: Run next wave of planned tasks in parallel with fresh context per task
---

Execute the next wave of tasks from the active plan. Each task runs in a **fresh agent context** to prevent context rot.

## Process

### Step 1: Load Plan

```bash
ls dev/active/
```

If multiple tasks exist, ask the user which one. Read `dev/active/[task-name]/tasks.md`.

### Step 2: Find Next Wave

Parse tasks.md and identify the next wave where ALL tasks are still unchecked (`- [ ]`). Skip waves that are fully complete (`- [x]`). If a wave is partially complete, execute only the remaining unchecked tasks in that wave.

If all waves are complete, report "All tasks complete. Run /verify to check the work." and stop.

### Step 3: Execute Wave

For each unchecked task in the wave, spawn a **separate Agent** (subagent_type: "general-purpose") with a prompt that includes:

1. The task's **Do** description (copy verbatim from tasks.md)
2. The task's **Files** list
3. The task's **Done when** criteria
4. A reminder to read CLAUDE.md and follow project conventions
5. Instruction to read each listed file BEFORE making changes

**Spawn all agents for the wave in a single message** so they run in parallel.

Example agent prompt format:
```
You are executing a planned task for the Owlette project. Read .claude/CLAUDE.md first for project conventions.

## Task: [Task name from tasks.md]

**Files to read/modify**: [file list]

**What to do**: [Do description from tasks.md]

**Success criteria**: [Done when from tasks.md]

Instructions:
- Read each file in the Files list BEFORE making any changes
- Follow all project conventions from CLAUDE.md
- Make only the changes described — nothing more
- Do NOT add comments, docstrings, or improvements beyond the task scope
- If you encounter a blocker, describe it clearly in your response instead of working around it
```

### Step 4: Review Results

After all agents complete:
1. Review each agent's response for success/failure/blockers
2. If any agent reports a blocker, flag it to the user
3. Run a quick build check: `cd web && npx tsc --noEmit 2>&1 | head -20` and `cd agent && python -m py_compile src/*.py 2>&1`

### Step 5: Update Progress

Mark completed tasks in `dev/active/[task-name]/tasks.md`:
- Change `- [ ]` to `- [x]` for each successfully completed task
- Add a log entry with the date and what was completed
- Update the progress counter at the top

### Step 6: Report

```
## Wave [N] Complete

**Executed**: [X] tasks
**Succeeded**: [Y]
**Failed/Blocked**: [Z] (if any — list details)

**Build status**: [pass/fail]
**Progress**: [completed]/[total] tasks ([%])

Next: [description of next wave, or "All waves complete — run /verify"]
```

If there are more waves and no blockers, ask: **"Continue with Wave [N+1]?"**

## Rules
- NEVER execute tasks from different waves simultaneously — waves must run in order
- Each agent gets a FRESH context — include all necessary information in the prompt
- If a task fails, do NOT automatically retry — report the failure and let the user decide
- Do not skip the build check between waves
- If agents report conflicting edits to the same file, stop and flag it — the plan has a dependency error
