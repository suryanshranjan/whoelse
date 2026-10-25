// `whoelse doctor`: is this machine and repo wired up?

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { baseBranch, repoRoot, worktrees } from '../git.js';
import { parseSymbols } from '../symbols.js';

function mentions(file: string, needle: string): boolean {
  try {
    return existsSync(file) && readFileSync(file, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

export async function doctor(cwd: string): Promise<number> {
  const home = homedir();
  const root = repoRoot(cwd);
  const rows: Array<[boolean, string]> = [];
  const anyOf = (files: string[], needle: string) => files.some((f) => mentions(f, needle));

  rows.push([
    anyOf([join(home, '.claude', 'settings.json'), ...(root ? [join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')] : [])], 'hook claude-code'),
    'Claude Code hooks',
  ]);
  if (existsSync(join(home, '.codex'))) {
    rows.push([anyOf([join(home, '.codex', 'hooks.json'), ...(root ? [join(root, '.codex', 'hooks.json')] : [])], 'hook codex'), 'Codex hooks (trust them with /hooks)']);
  }
  if (root && ['antigravity-ide', 'antigravity', 'antigravity-cli'].some((p) => existsSync(join(home, '.gemini', p)))) {
    rows.push([mentions(join(root, '.agents', 'hooks.json'), 'hook antigravity'), 'Antigravity hooks in .agents/hooks.json']);
  }
  let parses = false;
  try {
    parses = ((await parseSymbols('x.ts', 'export function f(a: number) { return g(a); }'))?.defs.length ?? 0) === 1;
  } catch {
    parses = false;
  }
  rows.push([parses, 'parser and grammars load']);
  if (root) {
    const n = worktrees(root).length;
    rows.push([true, `${n} worktree${n === 1 ? '' : 's'} (whoelse acts when there are 2 or more)`]);
    const base = baseBranch(root);
    rows.push([base !== null, `base branch: ${base ?? 'not found; set it with git config whoelse.base <branch>'}`]);
  }
  process.stdout.write(rows.map(([ok, what]) => `${ok ? '✓' : '✗'} ${what}`).join('\n') + '\n');
  return rows.every(([ok]) => ok) ? 0 : 1;
}
