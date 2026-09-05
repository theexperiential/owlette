/** @jest-environment node */

/**
 * `buildSystemPrompt` content contracts.
 *
 * The long-job guidance (hoot-async-turns 4.3) is the reason this file exists: the
 * prompt is the only thing that stops the model promising to "keep checking" a job it
 * cannot outlive, and it names tools (`schedule_followup`, `cancel_followup`) and a
 * parameter (`watch_command_id`) that must stay spelled exactly as `web/lib/mcp-tools.ts`
 * defines them. Both chat modes get it — site-wide turns run the same tools.
 */

import { buildSystemPrompt } from '@/lib/llm';

const MACHINE = 'LOBBY-01';

const machinePrompt = () => buildSystemPrompt(MACHINE, false);
const sitePrompt = () => buildSystemPrompt('', true);

describe('buildSystemPrompt — long-running work', () => {
  it.each([
    ['single-machine mode', machinePrompt],
    ['site-wide mode', sitePrompt],
  ])('%s states the execute_script timeout cap', (_label, build) => {
    const prompt = build();
    expect(prompt).toContain('execute_script');
    expect(prompt).toContain('3300 seconds (55 minutes)');
  });

  it.each([
    ['single-machine mode', machinePrompt],
    ['site-wide mode', sitePrompt],
  ])('%s teaches the detached pattern with a concrete example', (_label, build) => {
    const prompt = build();
    expect(prompt).toContain('Start-Process powershell');
    expect(prompt).toContain('-RedirectStandardOutput');
    // Windows paths survive the template literal — an unescaped `\P` would silently
    // collapse to `P` and ship a broken example.
    expect(prompt).toContain('C:\\ProgramData\\Owlette\\tmp\\install.ps1');
  });

  it.each([
    ['single-machine mode', machinePrompt],
    ['site-wide mode', sitePrompt],
  ])('%s names the follow-up tools and the watch parameter', (_label, build) => {
    const prompt = build();
    expect(prompt).toContain('schedule_followup');
    expect(prompt).toContain('cancel_followup');
    expect(prompt).toContain('watch_command_id');
    expect(prompt).toContain('delay_minutes');
  });

  it.each([
    ['single-machine mode', machinePrompt],
    ['site-wide mode', sitePrompt],
  ])('%s forbids "I will keep checking" promises', (_label, build) => {
    const prompt = build();
    expect(prompt).toContain('NEVER PROMISE TO KEEP WATCHING');
    expect(prompt).toContain('prefer scheduling a follow-up');
  });

  it.each([
    ['single-machine mode', machinePrompt],
    ['site-wide mode', sitePrompt],
  ])('%s requires a scheduled turn to announce itself', (_label, build) => {
    const prompt = build();
    // The literal the sweep injects — web/lib/hoot/followupSweep.server.ts.
    expect(prompt).toContain('[scheduled follow-up]');
    expect(prompt).toContain('WHEN A FOLLOW-UP WAKES YOU');
  });
});

describe('buildSystemPrompt — existing structure is intact', () => {
  it('keeps the numbered core rules ahead of the time context, in order', () => {
    const prompt = machinePrompt();
    expect(prompt.indexOf('RULE #1')).toBeGreaterThan(-1);
    expect(prompt.indexOf('RULE #2')).toBeGreaterThan(prompt.indexOf('RULE #1'));
    expect(prompt.indexOf('RULE #3')).toBeGreaterThan(prompt.indexOf('RULE #2'));
    expect(prompt.indexOf('TIME CONTEXT')).toBeGreaterThan(prompt.indexOf('RULE #3'));
  });

  it('still names the target machine and the site-wide aggregation contract', () => {
    expect(machinePrompt()).toContain(`connected to machine "${MACHINE}"`);
    expect(sitePrompt()).toContain('site-wide mode');
  });
});
