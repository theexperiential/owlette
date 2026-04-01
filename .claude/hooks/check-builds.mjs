/**
 * Stop Hook — Build Checker
 *
 * After Claude responds, checks session-edits.json for recently edited files.
 * Runs TypeScript check for web/ changes, Python syntax check for agent/ changes.
 * Reports errors back to Claude.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = join(__dirname, '..', 'session-edits.json')
const PROJECT_ROOT = join(__dirname, '..', '..')

// Read stdin (Stop hook receives empty or minimal input)
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  // Read recently edited files
  const editedFiles = getEditedFiles()
  if (editedFiles.length === 0) {
    process.exit(0)
  }

  // Determine affected repos
  const hasWeb = editedFiles.some(f => f.includes('/web/') || f.includes('\web\'))
  const hasAgent = editedFiles.some(f => f.includes('/agent/') || f.includes('\agent\'))

  if (!hasWeb && !hasAgent) {
    process.exit(0)
  }

  const results = []
  let hasErrors = false

  // Run web build check
  if (hasWeb) {
    try {
      execSync('npx tsc --noEmit', {
        cwd: join(PROJECT_ROOT, 'web'),
        timeout: 60000,
        stdio: 'pipe'
      })
      results.push('web: 0 errors')
    } catch (err) {
      hasErrors = true
      const output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '')
      const errors = output.split('\n').filter(l => /\.tsx?\(\d+,\d+\): error TS/.test(l))
      results.push(`web: ${errors.length || 'unknown'} error(s)`)
      errors.slice(0, 5).forEach(e => results.push(`  ${e.trim()}`))
      if (errors.length > 5) {
        results.push(`  ... and ${errors.length - 5} more`)
      }
    }
  }

  // Run agent build check
  if (hasAgent) {
    const agentFiles = editedFiles
      .filter(f => f.includes('/agent/') || f.includes('\agent\'))
      .filter(f => f.endsWith('.py'))

    if (agentFiles.length > 0) {
      let agentErrors = 0
      const errorMsgs = []

      for (const file of agentFiles) {
        try {
          execSync(`python -m py_compile "${file}"`, {
            cwd: PROJECT_ROOT,
            timeout: 10000,
            stdio: 'pipe'
          })
        } catch (err) {
          agentErrors++
          const msg = err.stderr?.toString().trim()
          if (msg) errorMsgs.push(`  ${msg}`)
        }
      }

      if (agentErrors > 0) hasErrors = true
      results.push(`agent: ${agentErrors} error(s) (${agentFiles.length} files checked)`)
      errorMsgs.forEach(m => results.push(m))
    }
  }

  if (results.length > 0) {
    const output = ['BUILD CHECK:', ...results].join('\n')
    process.stdout.write(JSON.stringify({
      decision: hasErrors ? 'block' : undefined,
      reason: output
    }))
  }

  // Clear session file after checking
  if (existsSync(SESSION_FILE)) {
    writeFileSync(SESSION_FILE, '[]')
  }

} catch {
  // Silent failure
}

process.exit(0)

function getEditedFiles() {
  if (!existsSync(SESSION_FILE)) return []
  try {
    const entries = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
    // Deduplicate by path
    const seen = new Set()
    return entries
      .map(e => e.path)
      .filter(p => { if (seen.has(p)) return false; seen.add(p); return true })
  } catch { return [] }
}
