// Every worktree's delta, and the clashes that concern the one we are in.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseBranch, canonical, repoRoot, stateDir, worktrees } from './git.js';
import { worktreeDelta, type Delta } from './delta.js';
import { findClashes, type Clash } from './clash.js';

export interface Scan {
  me: Delta;
  others: Delta[];
  clashes: Clash[];
}

// null when there is nothing to compare: not a repo, or a single worktree
export async function scan(cwd: string): Promise<Scan | null> {
  const root = repoRoot(cwd);
  if (!root) return null;
  const all = worktrees(root);
  if (all.length < 2) return null;
  const here = canonical(root);
  const mine = all.find((w) => canonical(w.path) === here);
  if (!mine) return null;
  const base = baseBranch(root);
  const me = await worktreeDelta(mine, base);
  const others: Delta[] = [];
  for (const w of all) if (w !== mine) others.push(await worktreeDelta(w, base));
  const clashes = others.flatMap((o) => findClashes(me, o));
  clashes.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'hard' ? -1 : 1));
  return { me, others, clashes };
}

// What this worktree's agent has already been told, so each clash is
// reported once. A clash that goes away and comes back is reported again.
interface Told {
  keys: string[];
  stopped: string[]; // hard clashes a Stop hook already held the agent on
}

function toldFile(cwd: string, worktree: string): string | null {
  const dir = stateDir(cwd);
  if (!dir) return null;
  const id = createHash('sha1').update(canonical(worktree).toLowerCase()).digest('hex').slice(0, 12);
  return join(dir, `told-${id}.json`);
}

function readTold(file: string): Told {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Told;
  } catch {
    // corrupt or half-written: start over
  }
  return { keys: [], stopped: [] };
}

function writeTold(file: string, told: Told): void {
  const tmp = `${file}.${process.pid}.tmp`; // several agents may write at once
  writeFileSync(tmp, JSON.stringify(told), 'utf8');
  renameSync(tmp, file);
}

export function untold(cwd: string, s: Scan): Clash[] {
  const file = toldFile(cwd, s.me.worktree);
  if (!file) return s.clashes;
  const told = readTold(file);
  const now = new Set(s.clashes.map((c) => c.key));
  const fresh = s.clashes.filter((c) => !told.keys.includes(c.key));
  writeTold(file, { keys: [...now], stopped: told.stopped.filter((k) => now.has(k)) });
  return fresh;
}

// Hard clashes the agent has not yet been held on at Stop.
export function unstopped(cwd: string, s: Scan): Clash[] {
  const file = toldFile(cwd, s.me.worktree);
  const hard = s.clashes.filter((c) => c.severity === 'hard');
  if (!file) return hard;
  const told = readTold(file);
  const fresh = hard.filter((c) => !told.stopped.includes(c.key));
  if (fresh.length) writeTold(file, { keys: [...new Set([...told.keys, ...s.clashes.map((c) => c.key)])], stopped: [...told.stopped, ...fresh.map((c) => c.key)] });
  return fresh;
}
