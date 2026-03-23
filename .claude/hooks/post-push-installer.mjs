/**
 * PostToolUse Hook — Remind to Build & Upload Installer After Agent Push
 *
 * After a successful `git push` that includes agent/src/ or agent/owlette_installer.iss
 * changes, injects a message telling Claude to build the installer and upload it
 * via the API.
 *
 * The actual build + upload is done by Claude (requires admin elevation + multi-step
 * API flow), not by this hook.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSION_FILE = join(__dirname, '..', 'session-edits.json')
const ENV_FILE = join(__dirname, '..', '.env.local')

// Read stdin
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  const data = JSON.parse(input)
  const command = data.tool_input?.command || ''

  // Only trigger on git push
  if (!/\bgit\s+push\b/.test(command)) {
    process.exit(0)
  }

  // Check if the tool succeeded (exit code 0)
  if (data.tool_result?.exit_code !== 0 && data.tool_result?.stdout?.includes('->')) {
    // Push may have failed
  }

  // Check session edits for agent files
  const agentFiles = getAgentFiles()
  if (agentFiles.length === 0) {
    process.exit(0)
  }

  // Load env for API config
  const env = loadEnv()
  if (!env.OWLETTE_API_KEY) {
    process.stderr.write('[post-push-installer] No API key in .claude/.env.local, skipping\n')
    process.exit(0)
  }

  // Determine which environment was pushed to
  const branch = getCurrentBranch()
  const apiUrl = branch === 'main' ? env.OWLETTE_PROD_API_URL : env.OWLETTE_DEV_API_URL
  const envLabel = branch === 'main' ? 'prod' : 'dev'

  // Read version
  let version = 'unknown'
  try {
    version = readFileSync(join(__dirname, '..', '..', 'VERSION'), 'utf-8').trim()
  } catch {}

  const message = [
    `Agent files were pushed to ${branch}. Build the installer and upload to ${envLabel}:`,
    '',
    `1. Build: powershell -Command "Start-Process cmd -ArgumentList '/c cd /D C:\\Users\\admin\\Documents\\Git\\Owlette\\agent && build_installer_full.bat' -Verb RunAs -Wait"`,
    `2. Upload via API (3-step process) to ${apiUrl}:`,
    `   - POST /api/admin/installer/upload with version "${version}"`,
    `   - PUT the .exe to the signed URL`,
    `   - PUT /api/admin/installer/upload to finalize`,
    `   API key and URLs are in .claude/.env.local`,
    '',
    `Changed agent files: ${agentFiles.join(', ')}`,
  ].join('\n')

  process.stderr.write(`[post-push-installer] Agent push detected, reminding to build+upload\n`)
  process.stdout.write(JSON.stringify({ message }))
} catch (err) {
  process.stderr.write(`[post-push-installer] Error: ${err.message}\n`)
}

process.exit(0)

function getAgentFiles() {
  if (!existsSync(SESSION_FILE)) return []
  try {
    const entries = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
    const seen = new Set()
    return entries
      .map(e => e.path)
      .filter(p => {
        const norm = p.replace(/\\/g, '/')
        return (norm.includes('agent/src/') && norm.endsWith('.py'))
          || norm.includes('agent/owlette_installer.iss')
      })
      .map(p => p.replace(/\\/g, '/').split('/').pop())
      .filter(f => { if (seen.has(f)) return false; seen.add(f); return true })
  } catch { return [] }
}

function loadEnv() {
  const env = {}
  if (!existsSync(ENV_FILE)) return env
  try {
    const lines = readFileSync(ENV_FILE, 'utf-8').split('\n')
    for (const line of lines) {
      const match = line.match(/^(\w+)=(.*)$/)
      if (match) env[match[1]] = match[2].trim()
    }
  } catch {}
  return env
}

function getCurrentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch {
    return 'dev'
  }
}
