/**
 * PostToolUse hook — mirrors an edited agent/src/*.py into
 * C:\ProgramData\Owlette\agent\src, clears its .pyc, and restarts OwletteService.
 *
 * Since 3.0.0 the local UI is the Tauri desktop app, so every mirrored file is
 * service-side; the service relaunches the tray itself after the restart.
 */

import { copyFileSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { basename, join } from 'path'
import { execSync } from 'child_process'

const PROG_DATA = process.env.PROGRAMDATA || 'C:\\ProgramData'
const PROD_SRC = `${PROG_DATA}\\Owlette\\agent\\src`

let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  const data = JSON.parse(input)
  const filePath = data.tool_input?.file_path
  if (!filePath) process.exit(0)

  const normalized = filePath.replace(/\\/g, '/')

  if (!normalized.includes('agent/src/') || !normalized.endsWith('.py')) {
    process.exit(0)
  }

  if (!existsSync(PROD_SRC)) {
    process.stderr.write(`[deploy-agent] ${PROD_SRC} not found, skipping\n`)
    process.exit(0)
  }

  const filename = basename(filePath)
  const dest = `${PROD_SRC}\\${filename}`
  try {
    copyFileSync(filePath, dest)
    process.stderr.write(`[deploy-agent] Copied ${filename} -> ${dest}\n`)
  } catch (err) {
    process.stderr.write(`[deploy-agent] Copy failed: ${err.message}\n`)
    process.exit(0)
  }

  // Clear stale .pyc cache so Python picks up the new source
  const moduleName = filename.replace('.py', '')
  const pycacheDir = join(PROD_SRC, '__pycache__')
  if (existsSync(pycacheDir)) {
    try {
      for (const f of readdirSync(pycacheDir)) {
        if (f.startsWith(moduleName + '.')) {
          unlinkSync(join(pycacheDir, f))
          process.stderr.write(`[deploy-agent] Cleared cache: ${f}\n`)
        }
      }
    } catch {
      // Non-critical — Python will still work, just might use old cache
    }
  }

  // Step 2: Restart service — every mirrored file is service-side since 3.0.0.
  {
    try {
      execSync(
        'powershell -Command "Start-Process cmd -ArgumentList \'/c net stop OwletteService && net start OwletteService\' -Verb RunAs -Wait"',
        { timeout: 15000, stdio: 'ignore' }
      )
      process.stderr.write('[deploy-agent] Restarted OwletteService\n')
    } catch (err) {
      process.stderr.write(`[deploy-agent] Service restart failed: ${err.message}\n`)
    }
    // Wait for service to initialize
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
} catch (err) {
  process.stderr.write(`[deploy-agent] Error: ${err.message}\n`)
}

process.exit(0)
