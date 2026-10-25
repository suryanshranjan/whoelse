// What one worktree changed since it forked from the base branch, at the
// symbol level. Read straight from git and the files on disk, so it works for
// any worktree on this machine whether or not its agent has hooks.

import { basename } from 'node:path';
import { baseBranch, changedFiles, fileAt, fileInTree, forkPoint, tryGit, type Worktree } from './git.js';
import { langFor, parseSymbols, type Def, type FileSymbols, type Ref } from './symbols.js';

export interface DefAt extends Def {
  file: string;
}

export interface Use extends Ref {
  file: string;
}

export interface Delta {
  worktree: string; // path
  label: string; // branch name, or folder name when detached
  base: string | null; // fork point sha
  removed: DefAt[];
  renamed: Array<DefAt & { to: string; toFile: string }>;
  signature: Array<DefAt & { before: string }>; // DefAt carries the new params / arity
  edited: DefAt[]; // body changed, same signature
  added: DefAt[];
  uses: Use[]; // references that are new in this worktree
  aliases: string[]; // old names this worktree newly keeps alive (export { new as old })
}

export function simpleName(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

// A live worktree: committed and uncommitted work, read from disk.
export async function worktreeDelta(wt: Worktree, base = baseBranch(wt.path)): Promise<Delta> {
  const from = forkPoint(wt, base);
  return build(wt.path, wt.branch ?? basename(wt.path), from, from ? changedFiles(wt.path, from) : [], (f) => fileInTree(wt.path, f));
}

// A branch tip (for CI, or branches with no worktree here): committed work only.
export async function branchDelta(cwd: string, branch: string, base = baseBranch(cwd)): Promise<Delta> {
  const from = (base && tryGit(['merge-base', branch, base], cwd)) || null;
  const files = from ? (tryGit(['diff', '--name-only', '--no-renames', from, branch], cwd) ?? '').split('\n').filter(Boolean) : [];
  return build(cwd, branch, from, files, (f) => fileAt(cwd, branch, f));
}

async function build(cwd: string, label: string, from: string | null, files: string[], read: (f: string) => string | null): Promise<Delta> {
  const delta: Delta = { worktree: cwd, label, base: from, removed: [], renamed: [], signature: [], edited: [], added: [], uses: [], aliases: [] };
  if (!from) return delta;
  const before = new Map<string, FileSymbols>();
  const after = new Map<string, FileSymbols>();
  for (const file of files) {
    if (!langFor(file)) continue;
    const old = fileAt(cwd, from, file);
    const now = read(file);
    if (old !== null) before.set(file, (await parseSymbols(file, old)) ?? { defs: [], refs: [] });
    if (now !== null) after.set(file, (await parseSymbols(file, now)) ?? { defs: [], refs: [] });
  }
  return diffSymbols(delta, before, after);
}

// Exported for tests: the symbol diff on already-parsed files.
export function diffSymbols(delta: Delta, before: Map<string, FileSymbols>, after: Map<string, FileSymbols>): Delta {
  for (const m of [before, after]) for (const s of m.values()) resolveAliases(s);
  const oldAliases = new Set([...before.values()].flatMap((s) => s.defs.filter((d) => d.aliasOf).map((d) => d.name)));
  delta.aliases = [...new Set([...after.values()].flatMap((s) => s.defs.filter((d) => d.aliasOf && !oldAliases.has(d.name)).map((d) => d.name)))];
  const flat = (m: Map<string, FileSymbols>): DefAt[] => [...m].flatMap(([file, s]) => s.defs.map((d) => ({ ...d, file })));
  const oldDefs = flat(before);
  const newDefs = flat(after);
  const key = (d: DefAt): string => `${d.file}::${d.name}`;
  const newByKey = new Map(newDefs.map((d) => [key(d), d]));
  const oldByKey = new Map(oldDefs.map((d) => [key(d), d]));
  const newByName = groupBy(newDefs, (d) => d.name);
  const oldByName = groupBy(oldDefs, (d) => d.name);

  const gone: DefAt[] = [];
  const matched = new Set<string>(); // new-side keys already paired
  for (const o of oldDefs) {
    // same file, else moved to another changed file under the same name
    let n = newByKey.get(key(o));
    if (!n) {
      const moved = (newByName.get(o.name) ?? []).filter((c) => !oldByKey.has(key(c)) && !matched.has(key(c)));
      if (moved.length === 1) n = moved[0];
    }
    if (!n) {
      gone.push(o);
      continue;
    }
    matched.add(key(n));
    if (n.params !== o.params) delta.signature.push({ ...n, before: o.params });
    else if (n.bodyHash !== o.bodyHash) delta.edited.push(n);
  }
  const fresh = newDefs.filter((n) => !matched.has(key(n)) && !oldByName.has(n.name));

  // a definition that disappeared and one that appeared with the same body
  // (or in the same place with the same parameters) is a rename
  for (const o of gone) {
    const i = fresh.findIndex(
      (n) => n.kind === o.kind && (n.bodyHash === o.bodyHash || (n.file === o.file && Math.abs(n.line - o.line) <= 2 && n.params === o.params)),
    );
    if (i >= 0) {
      const [n] = fresh.splice(i, 1);
      delta.renamed.push({ ...o, to: n.name, toFile: n.file });
    } else {
      delta.removed.push(o);
    }
  }
  delta.added.push(...fresh);

  // references that are new: per file, uses whose source line did not exist before
  for (const [file, s] of after) {
    const old = new Map<string, number>();
    for (const r of before.get(file)?.refs ?? []) old.set(refKey(r), (old.get(refKey(r)) ?? 0) + 1);
    for (const r of s.refs) {
      const k = refKey(r);
      const left = old.get(k) ?? 0;
      if (left > 0) old.set(k, left - 1);
      else delta.uses.push({ ...r, file });
    }
  }
  delta.uses.sort((x, y) => (x.file === y.file ? x.line - y.line : x.file < y.file ? -1 : 1));
  return delta;
}

// An alias stands for its target: same kind, parameters and body.
function resolveAliases(s: FileSymbols): void {
  for (const d of s.defs) {
    if (!d.aliasOf) continue;
    const t = s.defs.find((x) => x.name === d.aliasOf && !x.aliasOf);
    if (t) Object.assign(d, { kind: t.kind, params: t.params, minArgs: t.minArgs, maxArgs: t.maxArgs, bodyHash: t.bodyHash });
  }
}

function refKey(r: Ref): string {
  return `${r.member ? '.' : ''}${r.name}|${r.args}|${r.text}`;
}

function groupBy<T>(xs: T[], f: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = f(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}
