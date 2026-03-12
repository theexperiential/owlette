---
description: Create comprehensive strategic plan for a task or feature
---

You are in planning mode. Your task is to create a comprehensive strategic plan for implementing the user's request.

## Your Task

Research the codebase thoroughly and create a detailed implementation plan that includes:

### 1. Executive Summary (2-3 sentences)
Brief overview of what will be built and why it matters.

### 2. Context & Background
- What currently exists in the codebase
- What needs to change or be added
- Why this change is needed
- Any relevant history or previous attempts

### 3. Proposed Solution
- High-level architectural approach
- Technology choices and rationale
- Integration points with existing code
- Data flow and component interactions

### 4. Implementation Phases
Break the work into logical phases (e.g., Phase 1: Backend, Phase 2: Frontend, Phase 3: Testing)

For each phase:
- Goals and deliverables
- Key tasks
- Dependencies on other phases

### 5. Detailed Tasks
Comprehensive checklist of ALL tasks required:
- [ ] Specific, actionable items
- [ ] File creation/modification tasks
- [ ] Testing tasks
- [ ] Documentation tasks

### 6. Files to Modify/Create
List of all files that will be:
- Created: `web/components/NewComponent.tsx`
- Modified: `agent/src/firebase_client.py` (add deployment sync)
- Deleted: `web/lib/old-util.ts` (if applicable)

### 7. Risks & Mitigations
Identify potential challenges:
- Technical risks (performance, complexity, compatibility)
- Integration risks (breaking existing functionality)
- Timeline risks
- Mitigation strategies for each

### 8. Success Criteria
How will we know this is done correctly?
- Functional requirements met
- Performance benchmarks
- Test coverage achieved
- No regressions

### 9. Testing Strategy
- Unit tests needed
- Integration tests needed
- E2E tests needed
- Manual testing steps

### 10. Estimated Timeline
Realistic time estimate:
- Hours/days for each phase
- Total estimated time
- Key milestones

## Research Instructions

Before planning:
1. **Explore relevant files** - Read existing code in the areas you'll be modifying
2. **Understand architecture** - Review docs in `/docs/` directory
3. **Check dependencies** - Identify what code depends on what you're changing
4. **Find similar patterns** - Look for existing implementations to follow
5. **Review recent changes** - Check git history for context

## Output Format

Use clear markdown with headers, lists, and code blocks. Be thorough but concise.

## Important Notes

- Be realistic about complexity and timeline
- Identify ALL files that need changes
- Consider both web and agent if the feature spans both
- Think about Firebase data structure changes
- Consider error handling and edge cases
- Plan for testing from the start
- Document architectural decisions

## After Planning

Once you present the plan:
1. User will review and may request revisions
2. After approval, use `/create-dev-docs` to convert plan into dev doc files
3. Implementation begins with clear roadmap

Take your time. A good plan saves hours of implementation time.
