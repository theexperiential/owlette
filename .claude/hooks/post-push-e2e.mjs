/**
 * PostToolUse Hook — Watch the Playwright E2E run after a push
 *
 * After a successful `git push` to dev/main that touches files in the
 * .github/workflows/e2e.yml path filter (web/**, firestore.rules,
 * firebase.json, the workflow itself), injects an instruction telling Claude
 * to find the triggered "playwright e2e" run, watch it to completion via the
 * gh CLI, and — on failure — pull the failing logs, diagnose the root cause,
 * and PROPOSE a fix (no auto-repush; dev auto-deploys and main is protected).
 *
 * The hook does NOT poll CI itself — a 6–30 min `gh run watch` would hang the
 * harness. It only detects the push and hands Claude a recipe, matching the
 * sibling post-push-installer.mjs pattern.
 */

import { execSync } from 'child_process'

// The e2e workflow's path filter. Keep in sync with .github/workflows/e2e.yml.
const PATH_FILTER = [
  (f) => f.startsWith('web/'),
  (f) => f === 'firestore.rules',
  (f) => f === 'firebase.json',
  (f) => f === '.github/workflows/e2e.yml',
]

const matchesFilter = (file) => PATH_FILTER.some((m) => m(file))

let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  const data = JSON.parse(input)
  const command = data.tool_input?.command || ''

  // Only real pushes — skip non-push, dry-run, and ref deletions.
  if (!/\bgit\s+push\b/.test(command)) process.exit(0)
  if (/--dry-run\b/.test(command) || /--delete\b/.test(command) || /\s:\S/.test(command)) {
    process.exit(0)
  }

  // Push must have succeeded for CI to have been triggered.
  if (typeof data.tool_result?.exit_code === 'number' && data.tool_result.exit_code !== 0) {
    process.exit(0)
  }

  // e2e's `push:` trigger only fires on dev/main. (PR branches trigger via
  // pull_request — out of scope here; the dev/main path is the documented flow.)
  const branch = getCurrentBranch()
  if (branch !== 'dev' && branch !== 'main') process.exit(0)

  // Best-effort: did this push touch the e2e path filter? If we can't tell,
  // fail open (inject anyway) — better to over-verify than miss a red run.
  const { files, known } = getPushedFiles(branch)
  if (known && !files.some(matchesFilter)) {
    // Push had changes but none in the e2e scope — CI won't run the suite.
    process.exit(0)
  }

  const sha = getHeadSha()
  const scopeNote = known
    ? `Changed files in e2e scope: ${files.filter(matchesFilter).join(', ')}`
    : `(Could not determine the pushed diff — verify whether a run was actually triggered.)`

  const message = [
    `Pushed to ${branch} (${sha.slice(0, 8)}). This touched the playwright e2e path filter, so the "playwright e2e" workflow (.github/workflows/e2e.yml) should run. Verify it succeeded:`,
    '',
    `1. Find the run for this push:`,
    `   gh run list --workflow="playwright e2e" --branch ${branch} --limit 5 --json databaseId,headSha,status,conclusion,createdAt`,
    `   Pick the run whose headSha starts with ${sha.slice(0, 8)}. If none has appeared yet, GitHub can lag a few seconds — wait ~15s and retry once.`,
    `2. Watch it to completion (run in the BACKGROUND — cold CI can take up to ~30 min, target <6 min):`,
    `   gh run watch <databaseId> --exit-status`,
    `3. On SUCCESS: report green and stop.`,
    `4. On FAILURE:`,
    `   - gh run view <databaseId> --log-failed   # failing-step logs only`,
    `   - if needed: gh run download <databaseId> -n playwright-report   # HTML report + traces`,
    `   - diagnose the root cause, then PROPOSE a fix and wait for review. Do NOT auto-fix-and-repush.`,
    '',
    scopeNote,
  ].join('\n')

  process.stderr.write(`[post-push-e2e] ${branch} push in e2e scope — reminding Claude to watch the run\n`)
  process.stdout.write(JSON.stringify({ message }))
} catch (err) {
  process.stderr.write(`[post-push-e2e] Error: ${err.message}\n`)
}

process.exit(0)

function getCurrentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch {
    return ''
  }
}

function getHeadSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch {
    return ''
  }
}

/**
 * Diff the just-pushed range using the remote-tracking ref's reflog
 * (origin/<branch>@{1} = its value before this push). Returns { files, known }
 * where known=false means we couldn't determine it and the caller should fail open.
 */
function getPushedFiles(branch) {
  try {
    const out = execSync(
      `git diff --name-only "origin/${branch}@{1}..origin/${branch}"`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const files = out.split('\n').map((s) => s.trim()).filter(Boolean)
    return { files, known: true }
  } catch {
    return { files: [], known: false }
  }
}
