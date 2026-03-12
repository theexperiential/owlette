---
description: Update dev docs before context compaction
---

You are running low on context. Before compacting the conversation, update the dev docs with current progress so you can continue seamlessly in a fresh session.

## Task

Update all three dev doc files to capture:
1. Completed tasks
2. New context and decisions
3. Current state and next steps

## Instructions

### Step 1: Identify Active Task

Find the current task in `dev/active/`:

```bash
ls dev/active/
```

If multiple tasks exist, determine which one you're currently working on (ask user if unclear).

### Step 2: Update Tasks File

**File**: `dev/active/[task-name]/[task-name]-tasks.md`

1. Mark completed tasks with `[x]`:
   ```markdown
   - [x] Task 1: Implemented feature X
   - [x] Task 2: Added tests for Y
   - [ ] Task 3: Still needs to be done
   ```

2. Add any NEW tasks discovered during implementation:
   ```markdown
   ## Newly Discovered Tasks
   - [ ] Fix edge case found during testing
   - [ ] Add validation for Z
   ```

3. Update progress notes:
   ```markdown
   ### [Current Date]
   - Completed: Tasks 1-5
   - In progress: Task 6 (70% done)
   - Blocked: Task 8 (waiting for X)
   - Next: Will tackle Task 7 when session resumes
   ```

4. Update timestamp at bottom

### Step 3: Update Context File

**File**: `dev/active/[task-name]/[task-name]-context.md`

1. Add any NEW architectural decisions made during implementation:
   ```markdown
   ### [Current Date] - Additional Decisions
   - Decided to use X instead of Y because [reason]
   - Changed approach for Z to improve [aspect]
   ```

2. Update integration points if they changed

3. Add any new files created or modified:
   ```markdown
   ### Files Added During Implementation
   - `web/components/NewThing.tsx` - [Purpose]
   - `agent/src/new_module.py` - [Purpose]
   ```

4. Update "Next Steps" section with immediate next actions:
   ```markdown
   ## Next Steps (Current)
   1. Complete Task 6: [Specific details on what's left]
   2. Then tackle Task 7: [Brief description]
   3. Test edge cases: [List them]

   **Current Status**: About 60% complete. Core functionality works, testing in progress.
   ```

5. Add any important notes or discoveries:
   ```markdown
   ## Important Notes
   - Firebase query performance issue found - using compound index (see firebase-setup.md)
   - ProcessManager needs restart after config change (discovered during testing)
   ```

6. Update timestamp

### Step 4: Review Plan File (Optional Updates)

**File**: `dev/active/[task-name]/[task-name]-plan.md`

Generally don't modify the plan, but if there were MAJOR changes to approach:

Add a section at the end:
```markdown
---

## Plan Updates

### [Current Date]
Changed approach for [aspect] from [original] to [new approach] because:
- [Reason 1]
- [Reason 2]

Impact:
- [What changed]
- Timeline: [adjustment if any]
```

### Step 5: Confirm Update

Report a summary:

```markdown
✅ Dev docs updated successfully:

**Progress**: [X] of [Y] tasks completed ([Z]%)

**Completed This Session**:
- [Task 1]
- [Task 2]
- [Task 3]

**Next Steps**:
1. [Next task]
2. [Following task]

**Current Status**: [Brief status summary]

You can now safely compact the conversation. When you continue:
1. Read all three dev doc files
2. Pick up from "Next Steps"
3. Mark tasks complete as you finish them
```

## What to Capture

### ✅ DO Capture:
- Completed tasks (mark with [x])
- New tasks discovered
- Architectural decisions made
- Files created/modified
- Challenges encountered and solutions
- Next immediate steps
- Current status/progress percentage
- Important discoveries or notes

### ❌ DON'T Capture:
- Detailed code snippets (code speaks for itself)
- Routine implementation details
- Duplicate information already in plan
- Overly verbose explanations

## If No Active Task Found

If `dev/active/` is empty, report:

```
No active dev docs found. This might mean:
1. This task didn't use dev docs (small task)
2. Dev docs weren't created yet
3. Task was already completed and moved

No update needed. You can compact the conversation safely.
```

## Tips for Effective Updates

1. **Be specific** in next steps - future you will appreciate it
2. **Capture decisions** - why you chose approach X over Y
3. **Note blockers** - what's preventing progress
4. **Update progress** - percentage complete, what's left
5. **List dependencies** - what needs to happen before next step

The goal is to make resuming work effortless in a fresh session.
