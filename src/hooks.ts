// `whoelse hook <agent> [event]`: called by the agent with its hook JSON on
// stdin. Prints the agent's expected JSON reply on stdout. Never fails the
// agent: errors go to <common git dir>/whoelse/hooks.log and the reply is {}.
//
// What the agent hears:
//   after an edit or a new prompt: clashes it has not been told about yet
//   when it tries to finish: hard clashes, once, so it deals with them first

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './git.js';
import { describe, type Clash } from './clash.js';
import { scan, unstopped, untold } from './scan.js';

export type Agent = 'claude-code' | 'codex' | 'antigravity';

interface Input {
  hook_event_name?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  workspacePaths?: string[]; // antigravity
}

export function message(clashes: Clash[], header = 'whoelse: another agent is changing code you depend on'): string {
  const lines = clashes.map((c) => `${c.severity === 'hard' ? '⚠' : '·'} ${describe(c)}`);
  return [header, ...lines, 'Run `whoelse status` to see every worktree.'].join('\n');
}

function readInput(): Input {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? (JSON.parse(raw) as Input) : {};
  } catch {
    return {};
  }
}

// Returns the JSON reply to print. Exported for tests.
export async function reply(agent: Agent, event: string, input: Input, cwd: string): Promise<object> {
  const s = await scan(cwd);
  if (!s) return {};
  const stop = event === 'Stop' || event === 'stop';
  if (stop) {
    if (input.stop_hook_active) return {}; // already continuing because of a Stop hook
    const hard = unstopped(cwd, s);
    if (hard.length === 0) return {};
    const reason = message(hard, 'whoelse: before you finish, your work clashes with another agent');
    return agent === 'antigravity' ? { decision: 'continue', reason } : { decision: 'block', reason };
  }
  const fresh = untold(cwd, s);
  if (fresh.length === 0) return {};
  const text = message(fresh);
  if (agent === 'antigravity') return { injectSteps: [{ ephemeralMessage: text }] };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

export async function runHook(agent: Agent, eventArg: string | undefined): Promise<void> {
  const input = readInput();
  const cwd = input.cwd ?? input.workspacePaths?.[0] ?? process.cwd();
  const event = eventArg ?? input.hook_event_name ?? '';
  let out: object = {};
  try {
    out = await reply(agent, event, input, cwd);
  } catch (err) {
    try {
      const dir = stateDir(cwd);
      if (dir) appendFileSync(join(dir, 'hooks.log'), `${new Date().toISOString()} ${agent} ${event}: ${err instanceof Error ? err.stack : String(err)}\n`);
    } catch {
      // nothing left to do
    }
  }
  process.stdout.write(JSON.stringify(out));
}
