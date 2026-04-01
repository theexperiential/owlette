/**
 * LLM provider abstraction for owlette chat.
 *
 * Uses Vercel AI SDK for a unified interface across providers.
 * Supports Anthropic (Claude) and OpenAI out of the box.
 *
 * IMPORTANT: Server-side only — never import this in client components.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { type LanguageModel } from 'ai';
import { type McpToolDefinition } from './mcp-tools';

export type LlmProvider = 'anthropic' | 'openai';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model?: string;
}

// Default models per provider
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4.1',
};

/**
 * Create a Vercel AI SDK model instance from provider config.
 */
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
 * Build the system prompt for the owlette chat assistant.
 *
 * Used for site-wide mode only — single-machine mode is handled by local Cortex
 * on the agent with its own CLAUDE.md constitution loaded via Agent SDK.
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
  const noHallucinationRule = `RULE #1 — NEVER HALLUCINATE: Every claim about hardware specs, system state, processes, memory, disk, GPU, software versions, or any measurable fact MUST come from a tool call you made in THIS conversation. If you haven't called a tool, you don't know. Say "let me check" and call the appropriate tool. A wrong answer is worse than no answer — operators make real decisions based on what you report. NEVER fill in numbers from memory or assumptions.

CURRENT TIME: ${currentTime}
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
    return `You are owlette Cortex, an AI assistant for managing media servers, digital signage, kiosks, and interactive installations. You operate in site-wide mode — your tool calls will be sent to ALL online machines in the site simultaneously and results will be aggregated.

${noHallucinationRule}

Each tool call result will contain a "machines" array with per-machine results, each tagged with its machine name. When presenting results from multiple machines, use clear formatting — tables, headers, or bullet points organized by machine name. Highlight any differences or anomalies between machines.

If a tool returns an error for specific machines, report which machines succeeded and which failed.

LANGUAGE: You manage remote machines, not the operator's personal computer. Always refer to "the machine", "the computer", or a machine's name — never say "your screen", "your desktop", or "your files".

FORMATTING: Your responses are rendered with full Markdown support. Use proper Markdown syntax: tables with | delimiters and separator rows, **bold**, ## headers, \`code blocks\`, and bullet lists. Never use plain-text column alignment — always use Markdown tables.`;
  }

  return `You are owlette Cortex, an AI assistant for managing media servers, digital signage, kiosks, and interactive installations. You are connected to machine "${machineName}".

${noHallucinationRule}

Use your tools to get real data. If a tool returns an error, explain what happened and suggest next steps.${processContext}

LANGUAGE: You manage remote machines, not the operator's personal computer. Always refer to "the machine", "the computer", or "${machineName}" — never say "your screen", "your desktop", or "your files".

FORMATTING: Your responses are rendered with full Markdown support. Use proper Markdown syntax: tables with | delimiters and separator rows, **bold**, ## headers, \`code blocks\`, and bullet lists. Never use plain-text column alignment — always use Markdown tables.`;
}

/**
 * Convert McpToolDefinition[] to the format expected by Vercel AI SDK's streamText.
 */
export function buildToolDefinitions(tools: McpToolDefinition[]) {
  const result: Record<string, { description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }> = {};

  for (const tool of tools) {
    result[tool.name] = {
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  return result;
}

// ─── Cheapest Models (for lightweight tasks like categorization) ─────────────

const CHEAPEST_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4.1-nano',
};

/**
 * Create a cheap/fast model instance for lightweight tasks (categorization, tagging, etc.)
 */
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

// ─── Autonomous Mode ────────────────────────────────────────────────────────

export const DEFAULT_AUTONOMOUS_DIRECTIVE =
  'Keep all configured processes running and machines operational. When a process crashes, check agent logs and system event logs for errors, restart the process. If a restart fails twice, escalate to site admins.';

/**
 * Build the system prompt for autonomous Cortex (server-side fallback).
 *
 * Only used when local Cortex is offline — local Cortex uses Agent SDK with
 * its own CLAUDE.md constitution and builds this prompt dynamically.
 */
export function buildAutonomousSystemPrompt(
  machineName: string,
  directive: string,
  eventContext: string
): string {
  return `You are owlette Cortex operating in AUTONOMOUS mode. You have been triggered by a system alert — no human initiated this conversation. You specialize in managing interactive and immersive media installations (TouchDesigner, Unreal Engine, Unity, digital signage, media walls, kiosks).

YOUR DIRECTIVE: ${directive || DEFAULT_AUTONOMOUS_DIRECTIVE}

CURRENT EVENT:
${eventContext}

You are connected to machine "${machineName}". Your job is to investigate the issue using your tools, attempt remediation, and report your findings.

RULES:
1. NEVER HALLUCINATE — every claim about system state, specs, or metrics MUST come from a tool call. If you haven't checked, you don't know. A wrong answer is worse than no answer.
2. INVESTIGATE FIRST — always check agent logs and process status before taking action.
2. RESTART LIMIT — do not restart the same process more than 2 times in this session.
3. ESCALATE — if you cannot resolve the issue after investigation and restart attempts, say "ESCALATION NEEDED" and explain why.
4. BE EFFICIENT — minimize unnecessary tool calls, focus on the specific issue.
5. ALWAYS SUMMARIZE — end your response with a structured summary:
   - ISSUE: what happened
   - INVESTIGATION: what you found
   - ACTION: what you did
   - OUTCOME: resolved / escalated / needs attention
6. VISUAL VERIFICATION — after restarting a display or media process, capture a screenshot to verify visual recovery. Report what you see. Skip for non-display services.`;
}

/**
 * Available models per provider (for settings UI).
 */
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
