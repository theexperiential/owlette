# Development Task Tracking

This directory holds wave-based planning docs for the GSD-inspired task workflow
(see `.claude/CLAUDE.md` → "Task Workflow"). Most of it is gitignored working
state; only durable conclusions are committed.

## Structure

```
dev/
├── active/            # In-flight initiatives (gitignored)
│   └── [feature]/
│       ├── plan.md    # Strategic plan (waves, success criteria)
│       ├── context.md # Key files, decisions, integration points
│       └── tasks.md   # Wave-by-wave checklist
├── planned/           # Approved but not started (tracked)
├── completed/         # Archived finished/superseded initiatives (gitignored)
├── video-tutorials/   # Tutorial video production pipeline (tracked)
├── findings-ledger.md # Whole-app review ledger — OWL-xx findings + triage state
└── codeql-triage.md   # CodeQL alert triage record
```

## Workflow

1. **`/plan`** — research the codebase, write `plan.md` / `context.md` /
   `tasks.md` into `dev/active/[feature]/`.
2. **`/execute`** — run the next wave of tasks in parallel (fresh agent context
   per task), or **`/next`** — execute the next single task in the current
   context.
3. **`/verify`** — check completed work against the plan's success criteria.
4. **`/save`** — persist progress to the dev docs before context compaction;
   **`/resume`** — restore context in a new session.
5. When an initiative is fully shipped, move its folder to `dev/completed/`.

Use `/debug` for non-obvious bugs and `/build-and-fix` to build web + agent and
fix all errors. Skip `/plan` for single-file tweaks or small fixes.

## Conventions

- Keep `tasks.md` checkboxes and status headers honest — stale "in progress"
  headers on shipped work are how initiatives get re-audited months later.
- Raw agent transcripts/logs are scratch: they are gitignored and get deleted
  when an initiative is archived. Durable conclusions belong in the synthesis
  `.md`s, `findings-ledger.md`, or commits.
- One-off review dispatches live and die inside their initiative folder; do not
  create new loose folders at `dev/` root.

---

**Last Updated**: 2026-09-03
