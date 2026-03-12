/**
 * Stop Event Hook - Build Checker & Error Handling Reminder
 *
 * This hook runs AFTER Claude finishes responding. It:
 * 1. Tracks which files were edited during the session
 * 2. Determines affected repos (web vs agent)
 * 3. Runs appropriate build commands
 * 4. Shows errors immediately (if < 5) or recommends agent (if >= 5)
 * 5. Provides gentle reminders about error handling patterns
 *
 * GOAL: Zero TypeScript/Python errors left behind!
 */

import * as fs from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

interface EditedFile {
  path: string
  timestamp: number
  operation: 'edit' | 'write' | 'delete'
}

interface BuildResult {
  repo: string
  success: boolean
  errors: string[]
  errorCount: number
}

interface RiskyPattern {
  pattern: RegExp
  description: string
  reminder: string
}

/**
 * Main hook entry point
 */
export async function run(input: {}): Promise<{ output: string }> {
  try {
    // Get list of files edited in this session
    const editedFiles = getEditedFilesFromSession()

    if (editedFiles.length === 0) {
      return { output: '' } // No files edited, nothing to check
    }

    // Determine which repos were affected
    const affectedRepos = determineAffectedRepos(editedFiles)

    if (affectedRepos.length === 0) {
      return { output: '' } // No code repos affected
    }

    // Run builds for affected repos
    const buildResults = await runBuildsForRepos(affectedRepos)

    // Check for risky patterns in edited files
    const riskyPatterns = checkForRiskyPatterns(editedFiles)

    // Generate output message
    const output = generateOutputMessage(buildResults, riskyPatterns, editedFiles)

    return { output }

  } catch (error) {
    console.error('Error in stop hook:', error)
    return { output: '' } // On error, fail silently
  }
}

/**
 * Get list of files edited during this session
 */
function getEditedFilesFromSession(): EditedFile[] {
  // This is a simplified implementation
  // In production, you would track edits via post-tool-use hook
  // and maintain a session file

  // For now, return empty array
  // TODO: Implement file edit tracking via post-tool-use hook
  return []

  // Ideal implementation:
  // 1. post-tool-use hook writes to .claude/session-edits.json after each Edit/Write
  // 2. This function reads that file
  // 3. Clears the file after processing
}

/**
 * Determine which repositories were affected by edits
 */
function determineAffectedRepos(files: EditedFile[]): string[] {
  const repos = new Set<string>()

  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/')

    if (normalizedPath.includes('/web/')) {
      repos.add('web')
    } else if (normalizedPath.includes('/agent/')) {
      repos.add('agent')
    }
  }

  return Array.from(repos)
}

/**
 * Run builds for affected repositories
 */
async function runBuildsForRepos(repos: string[]): Promise<BuildResult[]> {
  const results: BuildResult[] = []
  const projectRoot = getProjectRoot()

  for (const repo of repos) {
    if (repo === 'web') {
      const result = await runWebBuild(projectRoot)
      results.push(result)
    } else if (repo === 'agent') {
      const result = await runAgentBuild(projectRoot)
      results.push(result)
    }
  }

  return results
}

/**
 * Run web dashboard build (TypeScript + Next.js)
 */
async function runWebBuild(projectRoot: string): Promise<BuildResult> {
  const webDir = path.join(projectRoot, 'web')

  try {
    // Run TypeScript compiler in check mode (faster than full build)
    const { stdout, stderr } = await execAsync('npx tsc --noEmit', {
      cwd: webDir,
      timeout: 60000 // 60 second timeout
    })

    return {
      repo: 'web',
      success: true,
      errors: [],
      errorCount: 0
    }

  } catch (error: any) {
    // TypeScript errors will be in stderr or stdout
    const output = error.stdout + error.stderr

    // Parse TypeScript errors
    const errors = parseTypeScriptErrors(output)

    return {
      repo: 'web',
      success: false,
      errors: errors.slice(0, 10), // Limit to first 10 errors for display
      errorCount: errors.length
    }
  }
}

/**
 * Run agent build (Python syntax check)
 */
async function runAgentBuild(projectRoot: string): Promise<BuildResult> {
  const agentDir = path.join(projectRoot, 'agent')

  try {
    // Run Python syntax checker
    const { stdout, stderr } = await execAsync('python -m py_compile src/*.py', {
      cwd: agentDir,
      timeout: 30000 // 30 second timeout
    })

    return {
      repo: 'agent',
      success: true,
      errors: [],
      errorCount: 0
    }

  } catch (error: any) {
    // Python errors will be in stderr
    const output = error.stderr

    // Parse Python errors
    const errors = parsePythonErrors(output)

    return {
      repo: 'agent',
      success: false,
      errors: errors.slice(0, 10), // Limit to first 10 errors
      errorCount: errors.length
    }
  }
}

/**
 * Parse TypeScript compiler errors
 */
function parseTypeScriptErrors(output: string): string[] {
  const errors: string[] = []
  const lines = output.split('\n')

  for (const line of lines) {
    // Match TypeScript error format: file.ts(line,col): error TS####: message
    if (line.match(/\.tsx?\(\d+,\d+\): error TS\d+:/)) {
      errors.push(line.trim())
    }
  }

  return errors
}

/**
 * Parse Python syntax errors
 */
function parsePythonErrors(output: string): string[] {
  const errors: string[] = []
  const lines = output.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Match Python error format: File "file.py", line X
    if (line.includes('File "') && line.includes('line ')) {
      // Get the error message (next line)
      const errorMsg = lines[i + 1] || ''
      errors.push(`${line.trim()} - ${errorMsg.trim()}`)
    }
  }

  return errors
}

/**
 * Check for risky patterns in edited files
 */
function checkForRiskyPatterns(files: EditedFile[]): Map<string, string[]> {
  const webPatterns: RiskyPattern[] = [
    {
      pattern: /try\s*{[\s\S]*?catch/,
      description: 'try-catch block',
      reminder: 'Error boundaries, toast notifications'
    },
    {
      pattern: /async\s+function|async\s*\(/,
      description: 'async operation',
      reminder: 'Error handling, loading states'
    },
    {
      pattern: /onSnapshot|getDoc|getDocs|setDoc|updateDoc/,
      description: 'Firestore operation',
      reminder: 'Offline handling, error callbacks'
    }
  ]

  const agentPatterns: RiskyPattern[] = [
    {
      pattern: /except\s+\w+:/,
      description: 'exception handling',
      reminder: 'Logging, graceful degradation'
    },
    {
      pattern: /psutil\.Process|subprocess\.Popen/,
      description: 'process operation',
      reminder: 'NoSuchProcess handling, timeout handling'
    },
    {
      pattern: /firestore\.|firebase_admin/,
      description: 'Firestore operation',
      reminder: 'Offline resilience, error logging'
    }
  ]

  const findings = new Map<string, string[]>()

  for (const file of files) {
    try {
      if (!fs.existsSync(file.path)) {
        continue
      }

      const content = fs.readFileSync(file.path, 'utf-8')
      const reminders: string[] = []

      // Determine which patterns to check
      const patterns = file.path.endsWith('.py') ? agentPatterns : webPatterns

      for (const pattern of patterns) {
        if (pattern.pattern.test(content)) {
          reminders.push(`${pattern.description}: ${pattern.reminder}`)
        }
      }

      if (reminders.length > 0) {
        findings.set(file.path, reminders)
      }

    } catch (error) {
      // Ignore files that can't be read
    }
  }

  return findings
}

/**
 * Generate output message
 */
function generateOutputMessage(
  buildResults: BuildResult[],
  riskyPatterns: Map<string, string[]>,
  editedFiles: EditedFile[]
): string {
  const lines: string[] = []

  // Build results section
  if (buildResults.length > 0) {
    lines.push('')
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    lines.push('🔨 BUILD CHECK')
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    lines.push('')

    for (const result of buildResults) {
      if (result.success) {
        lines.push(`✅ ${result.repo}: Build successful (0 errors)`)
      } else {
        lines.push(`❌ ${result.repo}: Build failed (${result.errorCount} error${result.errorCount > 1 ? 's' : ''})`)

        if (result.errorCount > 0 && result.errorCount < 5) {
          lines.push('')
          lines.push('Errors:')
          for (const error of result.errors) {
            lines.push(`   ${error}`)
          }
        } else if (result.errorCount >= 5) {
          lines.push('')
          lines.push('💡 Recommendation: Use /build-and-fix command or launch build-error-resolver agent')
          lines.push('')
          lines.push('First few errors:')
          for (const error of result.errors.slice(0, 3)) {
            lines.push(`   ${error}`)
          }
          lines.push(`   ... and ${result.errorCount - 3} more`)
        }
      }
      lines.push('')
    }

    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  }

  // Error handling reminder section
  if (riskyPatterns.size > 0) {
    lines.push('')
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    lines.push('📋 ERROR HANDLING SELF-CHECK')
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    lines.push('')

    const webFiles = Array.from(riskyPatterns.keys()).filter(f => !f.endsWith('.py'))
    const agentFiles = Array.from(riskyPatterns.keys()).filter(f => f.endsWith('.py'))

    if (webFiles.length > 0) {
      lines.push('⚠️  Web Changes Detected')
      lines.push(`   ${webFiles.length} file(s) with risky patterns`)
      lines.push('')
      lines.push('   ❓ Did you add error handling?')
      lines.push('   ❓ Are async operations wrapped in try-catch?')
      lines.push('   ❓ Are toast notifications shown on errors?')
      lines.push('   ❓ Are loading states displayed?')
      lines.push('')
      lines.push('   💡 Web Best Practices:')
      lines.push('      - Error boundaries for component errors')
      lines.push('      - Toast notifications for user feedback')
      lines.push('      - Firestore offline handling')
      lines.push('')
    }

    if (agentFiles.length > 0) {
      lines.push('⚠️  Agent Changes Detected')
      lines.push(`   ${agentFiles.length} file(s) with risky patterns`)
      lines.push('')
      lines.push('   ❓ Did you add logging for errors?')
      lines.push('   ❓ Are Firestore operations wrapped in error handling?')
      lines.push('   ❓ Are process operations handling NoSuchProcess?')
      lines.push('')
      lines.push('   💡 Agent Best Practices:')
      lines.push('      - Comprehensive logging (ERROR level)')
      lines.push('      - Graceful degradation on failures')
      lines.push('      - Offline resilience for Firestore')
      lines.push('')
    }

    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  }

  return lines.join('\n')
}

/**
 * Get project root directory
 */
function getProjectRoot(): string {
  // Assuming this hook is in .claude/hooks/
  return path.resolve(__dirname, '..', '..')
}
