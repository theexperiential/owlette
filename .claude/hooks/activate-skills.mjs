/**
 * UserPromptSubmit Hook — Skill Activation
 *
 * Analyzes prompt keywords and recently edited files to determine
 * which skills should activate, then prepends a reminder to the prompt.
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RULES_FILE = join(__dirname, 'skill-rules.json')
const SESSION_FILE = join(__dirname, '..', 'session-edits.json')
const MAX_AGE_MS = 10 * 60 * 1000

// Read JSON from stdin
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
}

try {
  const data = JSON.parse(input)
  const prompt = data.prompt || ''
  const promptLower = prompt.toLowerCase()

  // Load skill rules
  if (!existsSync(RULES_FILE)) {
    output(prompt)
    process.exit(0)
  }
  const config = JSON.parse(readFileSync(RULES_FILE, 'utf-8'))
  const maxSkills = config.activationConfig?.maxSkillsPerPrompt || 3

  // Score each skill
  const scored = []

  for (const [name, rule] of Object.entries(config.skills)) {
    let score = 0
    const reasons = []

    // Keyword matching
    for (const kw of rule.promptTriggers?.keywords || []) {
      if (promptLower.includes(kw.toLowerCase())) {
        score += 10
        reasons.push(`keyword: ${kw}`)
      }
    }

    // Intent pattern matching
    for (const pattern of rule.promptTriggers?.intentPatterns || []) {
      try {
        if (new RegExp(pattern, 'gi').test(prompt)) {
          score += 15
          reasons.push(`intent: ${pattern}`)
        }
      } catch { /* skip bad regex */ }
    }

    // File trigger matching (from session-edits.json)
    const recentFiles = getRecentFiles()
    for (const filePath of recentFiles) {
      for (const glob of rule.fileTriggers?.pathPatterns || []) {
        if (matchGlob(filePath, glob)) {
          score += 20
          reasons.push(`file: ${filePath}`)
          break
        }
      }
    }

    if (score > 0) {
      const priority = { high: 3, medium: 2, low: 1 }[rule.priority?.toLowerCase()] || 0
      scored.push({ name, score, priority, reasons })
    }
  }

  // Sort by priority then score, take top N
  scored.sort((a, b) => b.priority - a.priority || b.score - a.score)
  const top = scored.slice(0, maxSkills)

  if (top.length === 0) {
    output(prompt)
    process.exit(0)
  }

  // Build activation message
  const skillList = top.map((s, i) => `  ${i + 1}. ${s.name} (${s.reasons[0]})`).join('\n')
  const message = [
    '<skill-activation>',
    `Detected ${top.length} relevant skill(s):`,
    skillList,
    'Reference the guidelines from these skills.',
    '</skill-activation>'
  ].join('\n')

  output(`${message}\n\n${prompt}`)

} catch {
  // On error, pass prompt through unchanged
  try {
    const data = JSON.parse(input)
    output(data.prompt || '')
  } catch {
    process.exit(0)
  }
}

function output(prompt) {
  process.stdout.write(JSON.stringify({ prompt }))
}

function getRecentFiles() {
  if (!existsSync(SESSION_FILE)) return []
  try {
    const entries = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'))
    const now = Date.now()
    return entries
      .filter(e => (now - e.timestamp) < MAX_AGE_MS)
      .map(e => e.path.replace(/\\/g, '/'))
  } catch { return [] }
}

function matchGlob(filePath, pattern) {
  const regex = pattern
    .replace(/\\/g, '/')
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
  try {
    return new RegExp(`^${regex}$`).test(filePath.replace(/\\/g, '/'))
  } catch { return false }
}
