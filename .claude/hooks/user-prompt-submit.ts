/**
 * User Prompt Submit Hook - Skills Auto-Activation
 *
 * This hook runs BEFORE Claude sees the user's message. It analyzes:
 * 1. The user's prompt for keywords and intent patterns
 * 2. Recently edited files for path and content patterns
 * 3. Determines which skills should activate
 * 4. Injects skill activation reminder into Claude's context
 *
 * WITHOUT THIS HOOK, SKILLS WILL NOT AUTO-ACTIVATE!
 */

import * as fs from 'fs'
import * as path from 'path'

interface SkillRule {
  type: string
  enforcement: string
  priority: string
  description: string
  promptTriggers: {
    keywords: string[]
    intentPatterns: string[]
  }
  fileTriggers: {
    pathPatterns: string[]
    contentPatterns: string[]
  }
}

interface SkillRulesConfig {
  skills: Record<string, SkillRule>
  activationConfig: {
    maxSkillsPerPrompt: number
    priorityOrder: string[]
    requireExactKeywordMatch: boolean
    caseSensitive: boolean
    fileEditLookbackMinutes: number
  }
}

interface MatchResult {
  skillName: string
  score: number
  matchReasons: string[]
  priority: string
}

/**
 * Main hook entry point
 */
export async function run(input: { prompt: string }): Promise<{ prompt: string }> {
  try {
    // Load skill rules configuration
    const skillRules = loadSkillRules()
    if (!skillRules) {
      return input // If can't load rules, pass through unchanged
    }

    // Analyze prompt and determine which skills should activate
    const matches = analyzePromptForSkills(input.prompt, skillRules)

    // Get recently edited files
    const recentFiles = getRecentlyEditedFiles(skillRules.activationConfig.fileEditLookbackMinutes)

    // Check file triggers
    const fileMatches = analyzeFilesForSkills(recentFiles, skillRules)

    // Combine matches
    const allMatches = combineMatches(matches, fileMatches)

    // If no matches, return unchanged
    if (allMatches.length === 0) {
      return input
    }

    // Sort by priority and score
    const topMatches = selectTopSkills(allMatches, skillRules.activationConfig)

    // Generate activation message
    const activationMessage = generateActivationMessage(topMatches)

    // Inject activation message into prompt
    const modifiedPrompt = `${activationMessage}\n\n${input.prompt}`

    return { prompt: modifiedPrompt }

  } catch (error) {
    console.error('Error in user-prompt-submit hook:', error)
    return input // On error, pass through unchanged
  }
}

/**
 * Load skill rules from JSON file
 */
function loadSkillRules(): SkillRulesConfig | null {
  try {
    const hooksDir = __dirname
    const rulesPath = path.join(hooksDir, 'skill-rules.json')

    if (!fs.existsSync(rulesPath)) {
      console.warn('skill-rules.json not found')
      return null
    }

    const content = fs.readFileSync(rulesPath, 'utf-8')
    return JSON.parse(content)

  } catch (error) {
    console.error('Failed to load skill rules:', error)
    return null
  }
}

/**
 * Analyze user prompt for skill matches
 */
function analyzePromptForSkills(prompt: string, config: SkillRulesConfig): MatchResult[] {
  const matches: MatchResult[] = []
  const promptLower = config.activationConfig.caseSensitive ? prompt : prompt.toLowerCase()

  for (const [skillName, rule] of Object.entries(config.skills)) {
    const matchReasons: string[] = []
    let score = 0

    // Check keyword matches
    for (const keyword of rule.promptTriggers.keywords) {
      const keywordToMatch = config.activationConfig.caseSensitive ? keyword : keyword.toLowerCase()

      if (config.activationConfig.requireExactKeywordMatch) {
        // Exact word boundary match
        const regex = new RegExp(`\\b${escapeRegex(keywordToMatch)}\\b`, 'g')
        if (regex.test(promptLower)) {
          matchReasons.push(`Keyword: "${keyword}"`)
          score += 10
        }
      } else {
        // Substring match
        if (promptLower.includes(keywordToMatch)) {
          matchReasons.push(`Keyword: "${keyword}"`)
          score += 10
        }
      }
    }

    // Check intent pattern matches
    for (const pattern of rule.promptTriggers.intentPatterns) {
      try {
        const regex = new RegExp(pattern, config.activationConfig.caseSensitive ? 'g' : 'gi')
        if (regex.test(prompt)) {
          matchReasons.push(`Intent pattern: "${pattern}"`)
          score += 15 // Intent patterns are stronger signals
        }
      } catch (error) {
        console.warn(`Invalid regex pattern in ${skillName}: ${pattern}`)
      }
    }

    // If we have matches, add to results
    if (matchReasons.length > 0) {
      matches.push({
        skillName,
        score,
        matchReasons,
        priority: rule.priority
      })
    }
  }

  return matches
}

/**
 * Get list of recently edited files
 * (In a real implementation, this would query Claude Code's file tracking)
 */
function getRecentlyEditedFiles(lookbackMinutes: number): string[] {
  // This is a simplified implementation
  // In production, you would track edited files during the session
  // For now, return empty array (file triggers will only work if we track edits)
  return []

  // TODO: Implement file tracking
  // Possible approach:
  // 1. Maintain a session file that tracks Edit/Write operations
  // 2. Read that file here and filter by timestamp
  // 3. Return list of file paths
}

/**
 * Analyze recently edited files for skill matches
 */
function analyzeFilesForSkills(files: string[], config: SkillRulesConfig): MatchResult[] {
  const matches: MatchResult[] = []

  if (files.length === 0) {
    return matches
  }

  for (const [skillName, rule] of Object.entries(config.skills)) {
    const matchReasons: string[] = []
    let score = 0

    for (const file of files) {
      // Check path patterns
      for (const pathPattern of rule.fileTriggers.pathPatterns) {
        if (matchGlobPattern(file, pathPattern)) {
          matchReasons.push(`File path: ${file}`)
          score += 20 // File edits are strong signals
          break
        }
      }

      // Check content patterns (would require reading files)
      // Skipping content pattern check for performance
      // Can be added if needed
    }

    if (matchReasons.length > 0) {
      matches.push({
        skillName,
        score,
        matchReasons,
        priority: rule.priority
      })
    }
  }

  return matches
}

/**
 * Combine matches from prompt and file analysis, removing duplicates
 */
function combineMatches(promptMatches: MatchResult[], fileMatches: MatchResult[]): MatchResult[] {
  const combined = new Map<string, MatchResult>()

  // Add prompt matches
  for (const match of promptMatches) {
    combined.set(match.skillName, match)
  }

  // Merge file matches (add scores and reasons)
  for (const match of fileMatches) {
    if (combined.has(match.skillName)) {
      const existing = combined.get(match.skillName)!
      existing.score += match.score
      existing.matchReasons.push(...match.matchReasons)
    } else {
      combined.set(match.skillName, match)
    }
  }

  return Array.from(combined.values())
}

/**
 * Select top skills based on priority and score
 */
function selectTopSkills(matches: MatchResult[], config: SkillRulesConfig['activationConfig']): MatchResult[] {
  // Sort by priority (high > medium > low), then by score
  const priorityMap = { high: 3, medium: 2, low: 1 }

  matches.sort((a, b) => {
    const aPriority = priorityMap[a.priority.toLowerCase()] || 0
    const bPriority = priorityMap[b.priority.toLowerCase()] || 0

    if (aPriority !== bPriority) {
      return bPriority - aPriority // Higher priority first
    }

    return b.score - a.score // Higher score first
  })

  // Return top N skills
  return matches.slice(0, config.maxSkillsPerPrompt)
}

/**
 * Generate activation message to inject into prompt
 */
function generateActivationMessage(matches: MatchResult[]): string {
  if (matches.length === 0) {
    return ''
  }

  const lines: string[] = [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '🎯 SKILL ACTIVATION CHECK',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ''
  ]

  if (matches.length === 1) {
    const match = matches[0]
    lines.push(`📘 Detected: ${match.skillName}`)
    lines.push(`   Priority: ${match.priority.toUpperCase()}`)
    lines.push('')
    lines.push('Please reference the guidelines and patterns from this skill.')
  } else {
    lines.push(`📚 Detected ${matches.length} relevant skills:`)
    lines.push('')

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]
      lines.push(`   ${i + 1}. ${match.skillName} (${match.priority})`)
    }

    lines.push('')
    lines.push('Please reference the guidelines and patterns from these skills.')
  }

  lines.push('')
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  return lines.join('\n')
}

/**
 * Simple glob pattern matching
 */
function matchGlobPattern(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  // ** matches any number of directories
  // * matches any characters within a directory/filename

  let regexPattern = pattern
    .replace(/\\/g, '/')  // Normalize path separators
    .replace(/\./g, '\\.')  // Escape dots
    .replace(/\*\*/g, '###DOUBLESTAR###')  // Temporarily replace **
    .replace(/\*/g, '[^/]*')  // * matches anything except /
    .replace(/###DOUBLESTAR###/g, '.*')  // ** matches anything including /

  regexPattern = `^${regexPattern}$`

  const normalizedPath = filePath.replace(/\\/g, '/')

  try {
    return new RegExp(regexPattern).test(normalizedPath)
  } catch (error) {
    console.warn(`Invalid glob pattern: ${pattern}`)
    return false
  }
}

/**
 * Escape regex special characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
