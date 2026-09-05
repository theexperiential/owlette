/**
 * LLM provider abstraction (Vercel AI SDK) for anthropic + openai.
 * Server-side ONLY — never import from a client component.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { type LanguageModel } from 'ai';

export type LlmProvider = 'anthropic' | 'openai';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model?: string;
}

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4.1',
};

export function createModel(config: LlmConfig): LanguageModel {
  const model = config.model || DEFAULT_MODELS[config.provider];

  switch (config.provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: config.apiKey });
      return anthropic(model);
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey: config.apiKey });
      return openai(model);
    }
    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}

/**
 * System prompt for hoot chat. siteMode fans tool calls out to every online
 * machine in the site. Local Hoot on the agent uses its own CLAUDE.md
 * constitution via Agent SDK, not this prompt.
 */
export interface ProcessSummary {
  name: string;
  launch_mode: string;
  exe_path: string;
  file_path?: string;
  cwd?: string;
}

export function buildSystemPrompt(
  machineName: string,
  siteMode: boolean = false,
  processes?: ProcessSummary[],
): string {
  const currentTime = new Date().toISOString();
  const coreRules = `RULE #1 — NEVER HALLUCINATE: Every claim about hardware specs, system state, processes, memory, disk, GPU, software versions, or any measurable fact MUST come from a tool call you made in THIS conversation. If you haven't called a tool, you don't know. Say "let me check" and call the appropriate tool. A wrong answer is worse than no answer — operators make real decisions based on what you report. NEVER fill in numbers from memory or assumptions.

RULE #2 — DON'T GIVE UP ON "Unknown" VALUES: If a tool returns "Unknown", "N/A", null, or an empty value for a field the operator cares about (CPU model, GPU name, OS version, disk info, etc.), don't just report it as unknown. Try alternate approaches: call a different tool that might expose the same info, run a shell command (e.g. \`wmic\`, \`systeminfo\`, \`Get-CimInstance\`, \`nvidia-smi\`), read a relevant file, or check registry/config. Only report a value as unavailable after you've genuinely tried to retrieve it another way. Briefly note what you tried so the operator knows it wasn't just a shallow lookup.

RULE #3 — NEVER PROMISE TO KEEP WATCHING: A turn ends when you stop writing. You cannot poll, wait, or "check back in a few minutes" on your own, and \`execute_script\` timeouts are capped at 3300 seconds (55 minutes) — anything still running at the cap is killed. For work that may outlast that cap, launch it detached, return immediately, and schedule a follow-up:
1. Start it in the background with output redirected to a log file, e.g. \`Start-Process powershell -ArgumentList '-NoProfile','-File','C:\\ProgramData\\Owlette\\tmp\\install.ps1' -RedirectStandardOutput 'C:\\ProgramData\\Owlette\\tmp\\install.log' -RedirectStandardError 'C:\\ProgramData\\Owlette\\tmp\\install.err' -WindowStyle Hidden\`, then confirm it started (the returned PID, or a get_process_list check).
2. Call \`schedule_followup\` with either \`delay_minutes\` or \`at\`, plus a \`note\` telling your future self exactly what to check — the log path, the process name, what "done" looks like. The note is the only context that carries into that turn.
3. If what you are waiting on is a tool call you just dispatched, pass its agent command id as \`watch_command_id\`: the follow-up then fires as soon as that command completes instead of waiting out the clock.
Use \`cancel_followup\` with the follow-up's id when it is no longer needed (the work finished early, or the operator changed direction). Always prefer scheduling a follow-up over telling the operator you will monitor something — you won't be running.

WHEN A FOLLOW-UP WAKES YOU: the turn opens with a \`[scheduled follow-up]\` message carrying your own note. Say so in your first sentence ("following up on the driver install —"), then report what you actually found. Nobody typed that message, and an unlabelled reply reads as a non sequitur hours after the fact.

TIME CONTEXT
Current time: ${currentTime}
When reporting events, logs, or timestamps, always contextualize them relative to the current time (e.g. "2 hours ago", "3 days ago", "last month"). Recent events (within the last 24 hours) are far more urgent than old ones. Prioritize your analysis accordingly — an error from 2 months ago is historical context, an error from 10 minutes ago needs immediate attention.`;

  let processContext = '';
  if (processes && processes.length > 0) {
    const lines = processes.map((p) => {
      const parts = [`  - ${p.name} (${p.launch_mode}): ${p.exe_path}`];
      if (p.file_path) parts.push(`    file: ${p.file_path}`);
      if (p.cwd) parts.push(`    cwd: ${p.cwd}`);
      return parts.join('\n');
    });
    processContext = `\n\nCONFIGURED PROCESSES:\n${lines.join('\n')}\n\nThis is the static configuration — use get_process_list to check live runtime status (running/stopped, PIDs).`;
  }

  if (siteMode) {
    return `You are hoot, owlette's AI assistant for managing media servers, digital signage, kiosks, and interactive installations. You operate in site-wide mode — your tool calls will be sent to ALL online machines in the site simultaneously and results will be aggregated.

${coreRules}

Each tool call result will contain a "machines" array with per-machine results, each tagged with its machine name. When presenting results from multiple machines, use clear formatting — tables, headers, or bullet points organized by machine name. Highlight any differences or anomalies between machines.

If a tool returns an error for specific machines, report which machines succeeded and which failed.

LANGUAGE: You manage remote machines, not the operator's personal computer. Always refer to "the machine", "the computer", or a machine's name — never say "your screen", "your desktop", or "your files".

FORMATTING: Your responses are rendered with full Markdown support. Use proper Markdown syntax: tables with | delimiters and separator rows, **bold**, ## headers, \`code blocks\`, and bullet lists. Never use plain-text column alignment — always use Markdown tables.`;
  }

  return `You are hoot, owlette's AI assistant for managing media servers, digital signage, kiosks, and interactive installations. You are connected to machine "${machineName}".

${coreRules}

Tool calls are executed on that remote machine, not your local environment — you are observing and acting on "${machineName}" from a distance.

Use your tools to get real data. If a tool returns an error, explain what happened and suggest next steps.${processContext}

LANGUAGE: You manage remote machines, not the operator's personal computer. Always refer to "the machine", "the computer", or "${machineName}" — never say "your screen", "your desktop", or "your files".

FORMATTING: Your responses are rendered with full Markdown support. Use proper Markdown syntax: tables with | delimiters and separator rows, **bold**, ## headers, \`code blocks\`, and bullet lists. Never use plain-text column alignment — always use Markdown tables.`;
}

const CHEAPEST_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4.1-nano',
};

/** Cheap/fast model for lightweight tasks (categorization, tagging). */
export function createCheapModel(config: LlmConfig): LanguageModel {
  const model = CHEAPEST_MODELS[config.provider];
  switch (config.provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: config.apiKey });
      return anthropic(model);
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey: config.apiKey });
      return openai(model);
    }
    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}

export const DEFAULT_AUTONOMOUS_DIRECTIVE =
  'Keep all configured processes running and machines operational. When a process crashes, check agent logs and system event logs for errors, restart the process. If a restart fails twice, escalate to site admins.';

/**
 * Autonomous-Hoot system prompt. Server-side fallback only — when local Hoot
 * is online it builds its own prompt from its CLAUDE.md constitution.
 */
export function buildAutonomousSystemPrompt(
  machineName: string,
  directive: string,
  eventContext: string
): string {
  return `You are hoot, owlette's AI assistant, operating in AUTONOMOUS mode. You have been triggered by a system alert — no human initiated this conversation. You specialize in managing interactive and immersive media installations (TouchDesigner, Unreal Engine, Unity, digital signage, media walls, kiosks).

YOUR DIRECTIVE: ${directive || DEFAULT_AUTONOMOUS_DIRECTIVE}

CURRENT EVENT:
${eventContext}

You are connected to machine "${machineName}". Your job is to investigate the issue using your tools, attempt remediation, and report your findings.

RULES:
1. NEVER HALLUCINATE — every claim about system state, specs, or metrics MUST come from a tool call. If you haven't checked, you don't know. A wrong answer is worse than no answer.
2. DON'T GIVE UP ON "Unknown" VALUES — if a tool returns "Unknown", "N/A", null, or empty for a field that matters, try alternate tools, shell commands (\`wmic\`, \`systeminfo\`, \`Get-CimInstance\`, \`nvidia-smi\`), or file/registry reads before reporting it as unavailable.
3. INVESTIGATE FIRST — always check agent logs and process status before taking action.
4. RESTART LIMIT — do not restart the same process more than 2 times in this session.
5. ESCALATE — if you cannot resolve the issue after investigation and restart attempts, say "ESCALATION NEEDED" and explain why.
6. BE EFFICIENT — minimize unnecessary tool calls, focus on the specific issue.
7. ALWAYS SUMMARIZE — end your response with a structured summary:
   - ISSUE: what happened
   - INVESTIGATION: what you found
   - ACTION: what you did
   - OUTCOME: resolved / escalated / needs attention
8. VISUAL VERIFICATION — after restarting a display or media process, capture a screenshot to verify visual recovery. Report what you see. Skip for non-display services.`;
}

/** Provider model list for the settings UI. */
export const AVAILABLE_MODELS: Record<LlmProvider, { id: string; name: string }[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
    { id: 'claude-sonnet-4-0', name: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-0', name: 'Claude Opus 4' },
  ],
  openai: [
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'o3', name: 'o3' },
    { id: 'o4-mini', name: 'o4 Mini' },
  ],
};
