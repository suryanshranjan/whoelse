// `whoelse status`: every worktree, what it changed, and every clash.
// `whoelse check [branch...]`: the same as a gate; exit 1 on a hard clash.
// With branch names it compares their committed tips (for CI, where there
// are no worktrees); without, it compares the live worktrees here.

import { baseBranch, repoRoot, worktrees } from '../git.js';
import { branchDelta, worktreeDelta, type Delta } from '../delta.js';
import { describeNeutral, findClashes, type Clash } from '../clash.js';

function summary(d: Delta): string {
  const parts: string[] = [];
  for (const r of d.renamed.slice(0, 2)) parts.push(`renamed ${r.name} → ${r.to}`);
  if (d.renamed.length > 2) parts.push(`${d.renamed.length - 2} more renamed`);
  for (const r of d.removed.slice(0, 2)) parts.push(`removed ${r.name}`);
  if (d.removed.length > 2) parts.push(`${d.removed.length - 2} more removed`);
  if (d.signature.length) parts.push(`${d.signature.length} signature${d.signature.length === 1 ? '' : 's'} changed`);
  if (d.edited.length) parts.push(`${d.edited.length} edited`);
  if (d.added.length) parts.push(`${d.added.length} added`);
  return parts.length ? parts.join(' · ') : 'no symbol changes';
}

export interface Report {
  deltas: Delta[];
  clashes: Array<{ in: string; clash: Clash }>;
}

export function report(deltas: Delta[]): Report {
  const clashes: Report['clashes'] = [];
  for (let i = 0; i < deltas.length; i++) {
    for (let j = i + 1; j < deltas.length; j++) {
      for (const c of findClashes(deltas[i], deltas[j])) clashes.push({ in: deltas[i].label, clash: c });
    }
  }
  clashes.sort((a, b) => (a.clash.severity === b.clash.severity ? 0 : a.clash.severity === 'hard' ? -1 : 1));
  return { deltas, clashes };
}

function print(r: Report, base: string | null): void {
  const w = Math.max(...r.deltas.map((d) => d.label.length), 4);
  const out = [`whoelse · ${r.deltas.length} ${r.deltas.length === 1 ? 'branch' : 'branches'} · base ${base ?? '?'}`, ''];
  for (const d of r.deltas) {
    const bad = r.clashes.filter((c) => c.clash.severity === 'hard' && (c.in === d.label || c.clash.other === d.label)).length;
    out.push(`  ${bad ? '✗' : '✓'} ${d.label.padEnd(w)}  ${summary(d)}`);
  }
  out.push('');
  if (r.clashes.length === 0) out.push('  no clashes');
  for (const { in: where, clash } of r.clashes) {
    out.push(`  ${clash.severity === 'hard' ? '⚠' : '·'} ${describeNeutral(clash, where)}`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

async function collect(cwd: string, branches: string[]): Promise<{ deltas: Delta[]; base: string | null } | null> {
  const root = repoRoot(cwd);
  if (!root) return null;
  const base = baseBranch(root);
  if (branches.length) return { deltas: await Promise.all(branches.map((b) => branchDelta(root, b, base))), base };
  const deltas: Delta[] = [];
  for (const w of worktrees(root)) deltas.push(await worktreeDelta(w, base));
  return { deltas, base };
}

export async function status(cwd: string, args: string[]): Promise<number> {
  const got = await collect(cwd, args.filter((a) => !a.startsWith('--')));
  if (!got) {
    process.stderr.write('whoelse: not inside a git repository\n');
    return 1;
  }
  const r = report(got.deltas);
  if (args.includes('--json')) process.stdout.write(JSON.stringify(r, (k, v) => (v === Infinity ? 'Infinity' : v), 2) + '\n');
  else print(r, got.base);
  return 0;
}

export async function check(cwd: string, args: string[]): Promise<number> {
  const got = await collect(cwd, args.filter((a) => !a.startsWith('--')));
  if (!got) {
    process.stderr.write('whoelse: not inside a git repository\n');
    return 1;
  }
  const r = report(got.deltas);
  print(r, got.base);
  return r.clashes.some((c) => c.clash.severity === 'hard') ? 1 : 0;
}
