/**
 * LLM provider abstraction for Owlette chat.
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
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
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
 * Build the system prompt for the Owlette chat assistant.
 */
export function buildSystemPrompt(
  machineName: string,
  siteMode: boolean = false,
): string {
  if (siteMode) {
    return `You are Owlette Cortex, the intelligence layer for managing a fleet of remote Windows machines. You are currently operating in site-wide mode, meaning your tool calls will be sent to ALL online machines in the site simultaneously and results will be aggregated.

Each tool call result will contain a "machines" array with per-machine results, each tagged with its machine name. When presenting results from multiple machines, use clear formatting — tables, headers, or bullet points organized by machine name. Highlight any differences or anomalies between machines.

You have access to tools that can query system information, manage processes, and execute commands on the remote machines. Use them proactively to answer user questions — don't just guess, actually check.

Be concise but thorough. If a tool returns an error for specific machines, report which machines succeeded and which failed.`;
  }

  return `You are Owlette Cortex, the intelligence layer for managing remote Windows machines. You are currently connected to machine "${machineName}".

You have access to tools that can query system information, manage processes, read logs, and execute commands on this remote machine. Use them proactively to answer user questions — don't just guess, actually check.

Be concise but thorough. If a tool returns an error, explain what happened and suggest next steps. When showing system data, format it clearly using tables or structured lists.`;
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

// ─── Autonomous Mode ────────────────────────────────────────────────────────

export const DEFAULT_AUTONOMOUS_DIRECTIVE =
  'Keep all configured processes running and machines operational. When a process crashes, check agent logs and system event logs for errors, restart the process. If a restart fails twice, escalate to site admins.';

/**
 * Build the system prompt for autonomous Cortex (event-triggered, no human).
 */
export function buildAutonomousSystemPrompt(
  machineName: string,
  directive: string,
  eventContext: string
): string {
  return `You are Owlette Cortex operating in AUTONOMOUS mode. You have been triggered by a system alert — no human initiated this conversation.

YOUR DIRECTIVE: ${directive || DEFAULT_AUTONOMOUS_DIRECTIVE}

CURRENT EVENT:
${eventContext}

You are connected to machine "${machineName}". Your job is to investigate the issue using your tools, attempt remediation, and report your findings.

RULES:
1. INVESTIGATE FIRST — always check agent logs and process status before taking action.
2. RESTART LIMIT — do not restart the same process more than 2 times in this session.
3. ESCALATE — if you cannot resolve the issue after investigation and restart attempts, say "ESCALATION NEEDED" and explain why.
4. BE EFFICIENT — minimize unnecessary tool calls, focus on the specific issue.
5. ALWAYS SUMMARIZE — end your response with a structured summary:
   - ISSUE: what happened
   - INVESTIGATION: what you found
   - ACTION: what you did
   - OUTCOME: resolved / escalated / needs attention`;
}

/**
 * Available models per provider (for settings UI).
 */
export const AVAILABLE_MODELS: Record<LlmProvider, { id: string; name: string }[]> = {
  anthropic: [
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
    { id: 'claude-haiku-4-20250514', name: 'Claude Haiku 4' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'o3', name: 'o3' },
    { id: 'o3-mini', name: 'o3 Mini' },
  ],
};
