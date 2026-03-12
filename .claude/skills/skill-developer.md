# Skill Developer Guidelines

**Version**: 1.0.0
**Last Updated**: 2026-03-12
**Applies To**: `.claude/skills/` directory

---

## What Are Skills?

Skills are markdown files in `.claude/skills/` that auto-activate via the `user-prompt-submit` hook when their trigger conditions match. They provide domain-specific guidelines that Claude receives as context before processing the user's request.

---

## Creating a New Skill

### 1. Write the Skill File

Create `.claude/skills/{skill-name}.md`:

```markdown
# Skill Display Name

**Version**: 1.0.0
**Last Updated**: YYYY-MM-DD
**Applies To**: description of scope

---

## Section 1: Core Guidelines

Content here...

## Section 2: Patterns & Examples

Content here...
```

**Guidelines for skill content:**
- Lead with the most actionable information (patterns, do/don't rules)
- Keep under 200 lines — skills are injected into context on every match
- Use tables for reference data (module maps, command lists)
- Link to `skills/resources/*.md` for detailed docs that don't need to load every time
- Don't duplicate content from CLAUDE.md or other skills

### 2. Add Activation Rules

Add an entry to `.claude/hooks/skill-rules.json` under the `skills` object:

```json
"my-new-skill": {
  "type": "domain",
  "enforcement": "suggest",
  "priority": "high",
  "description": "One-line description for activation messages",
  "promptTriggers": {
    "keywords": ["keyword1", "keyword2"],
    "intentPatterns": ["(create|modify).*?thing"]
  },
  "fileTriggers": {
    "pathPatterns": ["path/to/files/**/*.ext"],
    "contentPatterns": ["import.*something"]
  }
}
```

**Field reference:**

| Field | Values | Purpose |
|-------|--------|---------|
| `type` | `domain`, `meta`, `process` | Category of skill |
| `enforcement` | `suggest`, `require` | How strongly to apply |
| `priority` | `high`, `medium`, `low` | Ordering when multiple skills match |
| `promptTriggers.keywords` | string[] | Words in user's message that trigger activation |
| `promptTriggers.intentPatterns` | regex[] | Regex patterns for more nuanced intent matching |
| `fileTriggers.pathPatterns` | glob[] | Recently edited file paths that trigger activation |
| `fileTriggers.contentPatterns` | regex[] | Content patterns in recently edited files |

**Activation limit**: Max 3 skills per prompt (configured in `activationConfig.maxSkillsPerPrompt`).

### 3. Add Resource Documents (Optional)

For detailed reference content that doesn't need to load on every skill activation, create files in `.claude/skills/resources/`:

```
skills/resources/my-detailed-reference.md
```

Then link from the skill file: `> See skills/resources/my-detailed-reference.md for full details`

Resource docs are read on-demand, not auto-injected.

---

## Existing Skills

| Skill | Type | Priority | Triggers On |
|-------|------|----------|-------------|
| `frontend-dev-guidelines` | domain | high | `.tsx` files, React/Next.js keywords |
| `backend-dev-guidelines` | domain | high | Agent `.py` files, Python/service keywords |
| `firebase-integration` | domain | high | Firebase imports, Firestore operations |
| `testing-guidelines` | domain | medium | Test files, "test" keyword |
| `skill-developer` | meta | medium | Editing skill files, "create skill" keywords |

## Existing Resources

| Resource | Purpose |
|----------|---------|
| `resources/agent-architecture.md` | Agent service internals, state machines, OAuth flow |
| `resources/installer-build-system.md` | Build pipeline, Inno Setup, NSSM, self-update |
| `resources/codebase-map.md` | Complete inventory of all components, hooks, modules |

---

## Hook System

Skills are activated by `.claude/hooks/user-prompt-submit.ts`, which:

1. Reads `skill-rules.json`
2. Matches user prompt keywords and intent patterns
3. Checks recently edited files against path and content patterns
4. Returns activation reminders for up to 3 matching skills

The `stop.ts` hook handles post-response quality checks (build verification, error reminders) — separate from skill activation.

---

## Best Practices

- **One domain per skill** — don't mix frontend and backend in one skill
- **Actionable over informational** — tell Claude what to do, not background history
- **Test activation** — edit a file matching your triggers and check if the skill activates
- **Update CLAUDE.md** — add new skills to the skills table in CLAUDE.md
- **Keep skills focused** — if content exceeds 200 lines, split into skill (guidelines) + resource (reference)
