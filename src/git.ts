// Thin git helpers. Everything shells out to the user's git; no library.

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export function git(args: string[], cwd: string, opts: ExecFileSyncOptions = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...opts,
  }) as string;
}

export function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd).trim();
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string | null {
  return tryGit(['rev-parse', '--show-toplevel'], cwd);
}

// Shared by every worktree of a repo, so it is where worktrees meet.
export function commonDir(cwd: string): string | null {
  const dir = tryGit(['rev-parse', '--git-common-dir'], cwd);
  return dir ? resolve(cwd, dir) : null;
}

export function stateDir(cwd: string): string | null {
  const dir = commonDir(cwd);
  if (!dir) return null;
  const state = join(dir, 'whoelse');
  if (!existsSync(state)) mkdirSync(state, { recursive: true });
  return state;
}

// Windows can hand us the same directory as a short (DEVANS~1) and a long
// path; resolve both through the filesystem before comparing.
export function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

export function toRepoPath(root: string, absPath: string): string {
  return relative(canonical(root), canonical(absPath)).split(sep).join('/');
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null; // short name, null when detached
}

export function worktrees(cwd: string): Worktree[] {
  const out = tryGit(['worktree', 'list', '--porcelain'], cwd);
  if (!out) return [];
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) list.push(cur);
      cur = { path: line.slice('worktree '.length), head: null, branch: null };
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (cur && line === 'bare') {
      cur.path = ''; // no working tree to read
    }
  }
  if (cur) list.push(cur);
  return list.filter((w) => w.path && existsSync(w.path));
}

// The branch every worktree is measured against: `whoelse.base` if set,
// else origin's default branch, else main/master.
export function baseBranch(cwd: string): string | null {
  const set = tryGit(['config', '--get', 'whoelse.base'], cwd);
  if (set) return set;
  const origin = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (origin) return origin;
  for (const b of ['main', 'master']) {
    if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], cwd)) return b;
  }
  // CI checkouts often have only the remote branches
  for (const b of ['origin/main', 'origin/master']) {
    if (tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${b}`], cwd)) return b;
  }
  return null;
}

// The commit a worktree's own changes start from. A worktree on the base
// branch itself is measured against its HEAD (only uncommitted work counts).
export function forkPoint(wt: Worktree, base: string | null): string | null {
  if (!wt.head) return null;
  if (!base || wt.branch === base || `origin/${wt.branch}` === base) return wt.head;
  return tryGit(['merge-base', 'HEAD', base], wt.path) ?? wt.head;
}

// Files that differ from the fork point: committed, staged, unstaged and
// untracked (but not ignored).
export function changedFiles(wtPath: string, from: string): string[] {
  const tracked = tryGit(['diff', '--name-only', '--no-renames', from], wtPath) ?? '';
  const untracked = tryGit(['ls-files', '--others', '--exclude-standard'], wtPath) ?? '';
  const all = new Set<string>();
  for (const l of [...tracked.split('\n'), ...untracked.split('\n')]) if (l.trim()) all.add(l.trim());
  return [...all];
}

export function fileAt(cwd: string, rev: string, repoPath: string): string | null {
  try {
    return git(['show', `${rev}:${repoPath}`], cwd);
  } catch {
    return null;
  }
}

export function fileInTree(wtPath: string, repoPath: string): string | null {
  try {
    return readFileSync(join(wtPath, repoPath), 'utf8');
  } catch {
    return null;
  }
}
