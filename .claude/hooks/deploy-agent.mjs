/**
 * PostToolUse Hook — Auto-Deploy Agent Changes to C:\ProgramData\Owlette
 *
 * When an agent/src/*.py file is edited, this hook:
 * 1. Copies the changed file to C:\ProgramData\Owlette\agent\src\
 * 2. Kills the GUI if running
 * 3. Restarts the OwletteService (if a service file was changed)
 * 4. Relaunches the GUI (if it was running)
 *
 * GUI-only files (owlette_gui.py) skip the service restart.
 */

import { copyFileSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { basename, join } from 'path'
import { execSync, exec } from 'child_process'

const PROG_DATA = process.env.PROGRAMDATA || 'C:\\ProgramData'
const PROD_SRC = `${PROG_DATA}\\Owlette\\agent\\src`
const PROD_PYTHON = `${PROG_DATA}\\Owlette\\python\\pythonw.exe`
const GUI_SCRIPT = `${PROG_DATA}\\Owlette\\agent\\src\\owlette_gui.py`

// Files that only affect the GUI (no service restart needed)
const GUI_ONLY_FILES = new Set(['owlette_gui.py', 'custom_messagebox.py'])

// Read JSON from stdin
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  const data = JSON.parse(input)
  const filePath = data.tool_input?.file_path
  if (!filePath) process.exit(0)

  // Normalize path separators for matching
  const normalized = filePath.replace(/\\/g, '/')

  // Only act on agent/src/*.py files
  if (!normalized.includes('agent/src/') || !normalized.endsWith('.py')) {
    process.exit(0)
  }

  // Skip if prod install doesn't exist
  if (!existsSync(PROD_SRC)) {
    process.stderr.write(`[deploy-agent] ${PROD_SRC} not found, skipping\n`)
    process.exit(0)
  }

  // Copy file to production
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

  const needsServiceRestart = !GUI_ONLY_FILES.has(filename)

  // Check if GUI is running
  let guiWasRunning = false
  try {
    const tasklist = execSync(
      'wmic process where "name=\'pythonw.exe\'" get CommandLine,ProcessId /FORMAT:CSV',
      { encoding: 'utf-8', timeout: 5000 }
    )
    const lines = tasklist.split('\n').filter(l => l.includes('owlette_gui.py'))
    if (lines.length > 0) {
      guiWasRunning = true
    }
  } catch {
    // wmic may fail — that's fine
  }

  // Step 1: Kill GUI if running
  if (guiWasRunning) {
    try {
      execSync(
        'taskkill /F /IM pythonw.exe /FI "WINDOWTITLE eq Owlette*"',
        { timeout: 5000, stdio: 'ignore' }
      )
      process.stderr.write('[deploy-agent] Killed running GUI\n')
    } catch {
      // May fail if already exited
    }
    // Brief pause for cleanup
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  // Step 2: Restart service (if needed)
  if (needsServiceRestart) {
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

  // Step 3: Relaunch GUI if it was running
  if (guiWasRunning) {
    exec(
      `start "" "${PROD_PYTHON}" "${GUI_SCRIPT}"`,
      {
        env: { ...process.env, PYTHONPATH: PROD_SRC },
        shell: true
      },
      () => {}
    )
    process.stderr.write('[deploy-agent] Relaunched GUI\n')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
} catch (err) {
  process.stderr.write(`[deploy-agent] Error: ${err.message}\n`)
}

process.exit(0)
