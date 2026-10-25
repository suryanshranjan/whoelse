// A main repo with pay.ts + api.ts and two worktrees, A and B, branched from main.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

export function fixture(): { main: string; a: string; b: string } {
  const root = mkdtempSync(join(tmpdir(), 'whoelse-'));
  const main = join(root, 'main');
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['core.autocrlf', 'false']]) git(main, ['config', k, v]);
  writeFileSync(join(main, 'pay.ts'), 'export function chargeCard(id: string, amt: number) {\n  return id + amt;\n}\n');
  writeFileSync(join(main, 'api.ts'), 'import { chargeCard } from "./pay";\nexport const go = () => chargeCard("x", 1);\n');
  git(main, ['add', '-A']);
  git(main, ['commit', '-q', '-m', 'init']);
  const a = join(root, 'a');
  const b = join(root, 'b');
  git(main, ['worktree', 'add', '-q', '-b', 'feat-payouts', a]);
  git(main, ['worktree', 'add', '-q', '-b', 'feat-refunds', b]);
  return { main, a, b };
}
