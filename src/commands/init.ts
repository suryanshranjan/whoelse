// `whoelse init`: wire the agents up.
//
// Parallel agents usually run in fresh worktrees, which do not carry a
// repo's uncommitted or local agent settings. So by default the Claude Code
// and Codex hooks go in the user-level config (~/.claude/settings.json,
// ~/.codex/hooks.json) and work in every repo; they do nothing in a repo
// with a single worktree. `--project` writes the repo's own files instead.
// Antigravity reads hooks from the repo (.agents/hooks.json): commit it so
// new worktrees get it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../git.js';
import { VERSION } from '../version.js';

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: 'command'; command: string; timeout?: number }>;
}
type Config = { hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

// How hooks should invoke us, decided by where this copy lives:
//  - npx cache (…/_npx/…): can be wiped, so pin `npx -y whoelse@<version>`
//  - an installed package (…/node_modules/whoelse/…): `whoelse` is on PATH
//  - a source checkout: call this very build with node
export function baseCommand(): string {
  const override = process.env.WHOELSE_COMMAND;
  if (override) return override;
  const self = fileURLToPath(import.meta.url).split('\\').join('/'); // .../dist/commands/init.js
  if (self.includes('/_npx/')) return `npx -y whoelse@${VERSION}`;
  if (self.includes('/node_modules/whoelse/')) return 'whoelse';
  return `node "${join(self, '..', '..', 'cli.js').split('\\').join('/')}"`;
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    throw new Error(`${file} is not valid JSON; fix it and re-run`);
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// Claude Code and Codex share a format: { hooks: { Event: [ {matcher?, hooks: [...]} ] } }
export function installHooks(file: string, command: string, editMatcher: string | null): void {
  const cfg = readJson<Config>(file, {});
  cfg.hooks ??= {};
  for (const event of ['PostToolUse', 'UserPromptSubmit', 'Stop']) {
    const list = (cfg.hooks[event] ??= []);
    if (list.some((e) => e.hooks.some((h) => h.command.includes('whoelse') && h.command.includes(' hook ')))) continue;
    const entry: HookEntry = { hooks: [{ type: 'command', command, timeout: 30 }] };
    if (event === 'PostToolUse' && editMatcher) entry.matcher = editMatcher;
    list.push(entry);
  }
  writeJson(file, cfg);
}

// Antigravity: named hooks, each mapping events to handlers. PreInvocation
// runs before every model call, which is where it can be told about a clash.
export function installAntigravityHooks(root: string, base: string): string {
  const file = join(root, '.agents', 'hooks.json');
  const cfg = readJson<Record<string, unknown>>(file, {});
  cfg.whoelse = {
    PreInvocation: [{ type: 'command', command: `${base} hook antigravity PreInvocation`, timeout: 30 }],
    Stop: [{ type: 'command', command: `${base} hook antigravity Stop`, timeout: 30 }],
  };
  writeJson(file, cfg);
  return file;
}

export function init(cwd: string, args: string[]): number {
  const project = args.includes('--project');
  const root = repoRoot(cwd);
  if (project && !root) {
    process.stderr.write('whoelse init --project: not inside a git repository\n');
    return 1;
  }
  const base = baseCommand();
  const home = homedir();
  const out: string[] = [];

  const claude = project ? join(root!, '.claude', 'settings.json') : join(home, '.claude', 'settings.json');
  installHooks(claude, `${base} hook claude-code`, 'Edit|Write|MultiEdit|NotebookEdit|Bash');
  out.push(`claude code: ${claude}`);

  if (existsSync(join(home, '.codex'))) {
    const codex = project ? join(root!, '.codex', 'hooks.json') : join(home, '.codex', 'hooks.json');
    installHooks(codex, `${base} hook codex`, null);
    out.push(`codex:       ${codex}\n             trust the hooks once with /hooks inside Codex`);
  }

  if (root && ['antigravity-ide', 'antigravity', 'antigravity-cli'].some((p) => existsSync(join(home, '.gemini', p)))) {
    out.push(`antigravity: ${installAntigravityHooks(root, base)}\n             commit it so new worktrees get it`);
  }

  out.push('', 'Run agents in separate worktrees as usual (git worktree add ../feat-x -b feat-x).');
  out.push('Each agent is told when another one breaks code it depends on. `whoelse status` shows all of it.');
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}
