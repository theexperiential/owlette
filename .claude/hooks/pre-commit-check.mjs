/**
 * PreToolUse hook — pre-commit build check.
 *
 * On git commit/push, reads session-edits.json and runs tsc + jest for web/
 * changes and py_compile + pytest for agent/ changes. Blocks on any error.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = join(__dirname, '..', 'session-edits.json')
const PROJECT_ROOT = join(__dirname, '..', '..')

let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  const data = JSON.parse(input)
  const toolInput = data.tool_input || {}

  const command = toolInput.command || ''
  const isCommit = /\bgit\s+(commit|push)\b/.test(command)
  if (!isCommit) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }))
    process.exit(0)
  }

  const editedFiles = getEditedFiles()
  if (editedFiles.length === 0) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }))
    process.exit(0)
  }

  const hasWeb = editedFiles.some(f => /[/\\]web[/\\]/.test(f))
  // The Python agent dir only — web/app/api/agent/* is TypeScript, not Python.
  const hasAgent = editedFiles.some(f => /[/\\]agent[/\\]/.test(f) && !/[/\\]web[/\\]/.test(f))

  if (!hasWeb && !hasAgent) {
    process.stdout.write(JSON.stringify({ decision: 'approve' }))
    process.exit(0)
  }

  const errors = []

  if (hasWeb) {
    try {
      execSync('npx tsc --noEmit', {
        cwd: join(PROJECT_ROOT, 'web'),
        timeout: 60000,
        stdio: 'pipe'
      })
    } catch (err) {
      const output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '')
      const tsErrors = output.split('\n').filter(l => /\.tsx?\(\d+,\d+\): error TS/.test(l))
      errors.push(`Web: ${tsErrors.length || 'unknown'} TypeScript error(s)`)
      tsErrors.slice(0, 5).forEach(e => errors.push(`  ${e.trim()}`))
      if (tsErrors.length > 5) errors.push(`  ... and ${tsErrors.length - 5} more`)
    }
  }

  if (hasAgent) {
    const pyFiles = editedFiles
      .filter(f => /[/\\]agent[/\\]/.test(f) && f.endsWith('.py'))

    for (const file of pyFiles) {
      try {
        execSync(`python -m py_compile "${file}"`, {
          cwd: PROJECT_ROOT,
          timeout: 10000,
          stdio: 'pipe'
        })
      } catch (err) {
        const msg = err.stderr?.toString().trim()
        errors.push(`Agent: syntax error in ${file.split(/[/\\]/).pop()}`)
        if (msg) errors.push(`  ${msg}`)
      }
    }
  }

  if (hasWeb) {
    try {
      // 300s: the suite outgrew 90s during the billing sprint (~2900 tests,
      // 100-140s warm). An execSync timeout kill surfaces as a bare "Jest tests
      // failed" with no summary, which reads like a red suite when it isn't.
      execSync('npx jest --bail --forceExit', {
        cwd: join(PROJECT_ROOT, 'web'),
        timeout: 300000,
        stdio: 'pipe'
      })
    } catch (err) {
      const output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '')
      const lines = output.split('\n')
      const summary = lines.find(l => /Tests:\s+/.test(l))
      const failSuites = lines.filter(l => /^FAIL\s/.test(l))
      errors.push(`Web: ${summary?.trim() || 'Jest tests failed'}`)
      failSuites.slice(0, 5).forEach(s => errors.push(`  ${s.trim()}`))
      if (failSuites.length > 5) errors.push(`  ... and ${failSuites.length - 5} more`)
    }
  }

  if (hasAgent) {
    try {
      execSync('python -m pytest agent/tests/ -x -q --tb=line', {
        cwd: PROJECT_ROOT,
        timeout: 60000,
        stdio: 'pipe'
      })
    } catch (err) {
      const output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '')
      const lines = output.split('\n')
      const summary = lines.find(l => /\d+ (failed|passed|error)/.test(l))
      const failTests = lines.filter(l => /^FAILED\s/.test(l))
      errors.push(`Agent: ${summary?.trim() || 'pytest failed'}`)
      failTests.slice(0, 5).forEach(t => errors.push(`  ${t.trim()}`))
      if (failTests.length > 5) errors.push(`  ... and ${failTests.length - 5} more`)
    }
  }

  if (errors.length > 0) {
    const reason = [
      'BUILD CHECK FAILED — fix errors before committing:',
      ...errors
    ].join('\n')
    process.stdout.write(JSON.stringify({ decision: 'block', reason }))
  } else {
    process.stdout.write(JSON.stringify({ decision: 'approve' }))
  }

} catch (err) {
  // Fail open.
  process.stdout.write(JSON.stringify({ decision: 'approve' }))
}

process.exit(0)

function getEditedFiles() {
  if (!existsSync(SESSION_FILE)) return []
  try {
    const entries = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
    const seen = new Set()
    return entries
      .map(e => e.path)
      .filter(p => { if (seen.has(p)) return false; seen.add(p); return true })
  } catch { return [] }
}
