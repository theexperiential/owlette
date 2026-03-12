---
description: Resume work from dev docs after context compaction or new session
---

You are starting a new session or resuming after context compaction. Load the dev docs to restore context and continue implementation.

## Task

1. **Find active task**:
   ```bash
   ls dev/active/
   ```
   If empty, report "No active dev docs found" and stop.

2. **Read all three dev doc files** for the active task:
   - `dev/active/[task-name]/[task-name]-plan.md` — Full implementation plan
   - `dev/active/[task-name]/[task-name]-context.md` — Key context, decisions, integration points
   - `dev/active/[task-name]/[task-name]-tasks.md` — Task checklist with progress

3. **Summarize current state** to the user:
   ```
   ## Resuming: [Feature Name]

   **Progress**: [X] of [Y] tasks completed ([Z]%)
   **Last Updated**: [date from tasks file]

   ### Completed
   - [x] Task 1
   - [x] Task 2

   ### In Progress / Next Up
   - [ ] Task 3 — [any notes from context file]
   - [ ] Task 4

   ### Key Context
   - [Important decisions or discoveries from context file]
   - [Any blockers or notes]
   ```

4. **Ask the user** what to work on next, or proceed with the next unchecked task if the path is clear.

## Rules

- Read ALL three files before summarizing — don't skip the context file
- Pay attention to the "Next Steps" section in the context file — it was written specifically for this moment
- Check the "Progress Notes" in the tasks file for session-specific context
- If the plan was updated (check "Plan Updates" section), note the changes
- Mark tasks complete as you finish them during this session
- Use `/update-dev-docs` before this session's context gets compacted

## If Multiple Active Tasks

If `dev/active/` contains multiple task directories:
1. List them all with their status (from tasks files)
2. Ask the user which one to resume
3. Load only the selected task's files
