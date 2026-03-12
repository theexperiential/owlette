---
description: Convert approved plan into dev doc files
---

A strategic plan has been approved. Your task is to convert it into the three dev doc files.

## Task

Create three files in `dev/active/[task-name]/`:

1. **[task-name]-plan.md** - The complete approved plan
2. **[task-name]-context.md** - Key context and integration points
3. **[task-name]-tasks.md** - Detailed task checklist

## Instructions

### Step 1: Determine Task Name

From the approved plan, create a task name:
- Use kebab-case (e.g., `remote-deployment-feature`)
- Keep it concise but descriptive
- Reflect the main feature/goal

### Step 2: Create Directory

```bash
mkdir -p dev/active/[task-name]
```

### Step 3: Create Plan File

**File**: `dev/active/[task-name]/[task-name]-plan.md`

Copy the ENTIRE approved plan into this file. Include all sections:
- Executive Summary
- Context & Background
- Proposed Solution
- Implementation Phases
- Detailed Tasks
- Files to Modify/Create
- Risks & Mitigations
- Success Criteria
- Testing Strategy
- Estimated Timeline

Add metadata at the top:
```markdown
# [Feature Name] - Implementation Plan

**Created**: [Current Date]
**Status**: In Progress
**Estimated Time**: [From plan]

---

[Rest of plan content]
```

### Step 4: Create Context File

**File**: `dev/active/[task-name]/[task-name]-context.md`

Extract and organize key context:

```markdown
# [Feature Name] - Context & Integration Points

**Last Updated**: [Current Date]

## Key Files

List all files involved (from "Files to Modify/Create" section):

### To Create
- `path/to/new/file.ts` - Purpose

### To Modify
- `path/to/existing/file.py` - Changes needed

## Architectural Decisions

Document key decisions made during planning:
1. [Decision with rationale]
2. [Decision with rationale]

## Integration Points

How this feature integrates with existing code:
- **Web Dashboard**: [Integration details]
- **Python Agent**: [Integration details]
- **Firebase**: [Data structure changes]

## Dependencies

External dependencies:
- New npm packages: [list]
- New Python packages: [list]

Internal dependencies:
- Must complete X before starting Y

## Data Flow

Brief description of how data flows through the system:
```
User Action → Frontend → Firestore → Agent → Process
```

## Edge Cases & Considerations

- [Edge case 1]
- [Edge case 2]

## Next Steps

Immediate next steps to begin implementation:
1. [Step 1]
2. [Step 2]

---
**Last Updated**: [Current Date]
```

### Step 5: Create Tasks File

**File**: `dev/active/[task-name]/[task-name]-tasks.md`

Convert the detailed tasks into a checklist:

```markdown
# [Feature Name] - Task Checklist

**Last Updated**: [Current Date]

## Phase 1: [Phase Name]

- [ ] Task 1: [Specific action]
- [ ] Task 2: [Specific action]
- [ ] Task 3: [Specific action]

## Phase 2: [Phase Name]

- [ ] Task 1: [Specific action]
- [ ] Task 2: [Specific action]

## Phase 3: [Phase Name]

- [ ] Task 1: [Specific action]
- [ ] Task 2: [Specific action]

## Testing

- [ ] Unit tests for [component]
- [ ] Integration tests for [feature]
- [ ] Manual testing: [scenarios]

## Documentation

- [ ] Update README if needed
- [ ] Add code comments
- [ ] Update architecture docs

---

## Progress Notes

### [Current Date]
- Created dev docs
- Ready to begin implementation

---
**Last Updated**: [Current Date]
```

### Step 6: Confirm Completion

After creating all three files, report:

```
✅ Dev docs created successfully:

📁 dev/active/[task-name]/
   ├── [task-name]-plan.md (XXX lines)
   ├── [task-name]-context.md (XXX lines)
   └── [task-name]-tasks.md (XXX tasks)

You can now begin implementation. Tasks are tracked in tasks.md - mark them complete as you finish each one.

To update these docs before context compaction, run: /update-dev-docs
```

## Important Notes

- Include ALL details from the original plan
- Make tasks SPECIFIC and actionable
- Update timestamps
- Context file should be a quick reference, not a repeat of the plan
- Tasks file should have checkboxes for every actionable item

## If Plan Not Available

If you can't find the approved plan, ask the user to:
1. Provide the plan
2. OR use `/dev-docs` to create a plan first

Do not proceed without a clear plan to work from.
