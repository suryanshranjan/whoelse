// Compare one worktree's delta with another's. Each clash is described from
// the point of view of `mine`, the worktree whose agent is being told.
//
// hard: the branches will not work together once merged
//   gone       one side removed or renamed a symbol the other newly uses
//   signature  one side changed a function's parameters, the other's new
//              calls no longer fit
// soft: worth knowing, may be fine
//   both-edited  both changed the same definition
//   both-added   both added a definition with the same name

import { simpleName, type DefAt, type Delta, type Use } from './delta.js';

export type ClashKind = 'gone' | 'signature' | 'both-edited' | 'both-added';

export interface Clash {
  kind: ClashKind;
  severity: 'hard' | 'soft';
  other: string; // the other worktree's label
  symbol: string;
  actor: 'me' | 'them'; // whose change broke whose use (hard kinds)
  def: DefAt; // the changed definition
  to?: string; // new name, for renames
  uses: Use[]; // the uses that break
  key: string; // stable id, to report each clash once
}

function usesOf(d: DefAt, uses: Use[]): Use[] {
  const name = simpleName(d.name);
  const member = d.kind === 'method';
  return uses.filter((u) => u.name === name && u.member === member);
}

function definesItself(delta: Delta, name: string): boolean {
  return delta.added.some((d) => simpleName(d.name) === name) || delta.renamed.some((r) => simpleName(r.to) === name);
}

function fits(d: DefAt, u: Use): boolean {
  return u.args < 0 || (u.args >= d.minArgs && u.args <= d.maxArgs);
}

function directional(changer: Delta, user: Delta, actor: 'me' | 'them', other: string): Clash[] {
  const out: Clash[] = [];
  for (const d of [...changer.removed, ...changer.renamed]) {
    const name = simpleName(d.name);
    if (definesItself(user, name)) continue;
    const broken = usesOf(d, user.uses);
    if (broken.length === 0) continue;
    const to = 'to' in d ? (d as { to: string }).to : undefined;
    out.push({ kind: 'gone', severity: 'hard', other, symbol: d.name, actor, def: d, to, uses: broken, key: `gone|${actor}|${other}|${d.file}|${d.name}|${broken.length}` });
  }
  for (const d of changer.signature) {
    const broken = usesOf(d, user.uses).filter((u) => !fits(d, u));
    if (broken.length === 0) continue;
    out.push({ kind: 'signature', severity: 'hard', other, symbol: d.name, actor, def: d, uses: broken, key: `signature|${actor}|${other}|${d.file}|${d.name}|${d.params}|${broken.length}` });
  }
  return out;
}

export function findClashes(mine: Delta, theirs: Delta): Clash[] {
  const other = theirs.label;
  const out = [...directional(theirs, mine, 'them', other), ...directional(mine, theirs, 'me', other)];

  const changed = (d: Delta): DefAt[] => [...d.edited, ...d.signature];
  const theirChanged = new Map(changed(theirs).map((d) => [`${d.file}::${d.name}`, d]));
  for (const d of changed(mine)) {
    if (!theirChanged.has(`${d.file}::${d.name}`)) continue;
    out.push({ kind: 'both-edited', severity: 'soft', other, symbol: d.name, actor: 'me', def: d, uses: [], key: `both-edited|${other}|${d.file}|${d.name}` });
  }
  const theirAdded = new Map(theirs.added.map((d) => [`${d.kind}::${d.name}`, d]));
  for (const d of mine.added) {
    const t = theirAdded.get(`${d.kind}::${d.name}`);
    if (!t || d.kind === 'const') continue; // two files with the same local constant name is normal
    out.push({ kind: 'both-added', severity: 'soft', other, symbol: d.name, actor: 'them', def: t, uses: [], key: `both-added|${other}|${d.name}` });
  }
  return out;
}

function where(us: Use[]): string {
  const shown = us.slice(0, 4).map((u) => `${u.file}:${u.line}`).join(', ');
  return us.length > 4 ? `${shown} and ${us.length - 4} more` : shown;
}

function arity(d: DefAt): string {
  if (d.maxArgs === Infinity) return `${d.minArgs}+ arguments`;
  if (d.minArgs === d.maxArgs) return `${d.minArgs} argument${d.minArgs === 1 ? '' : 's'}`;
  return `${d.minArgs}-${d.maxArgs} arguments`;
}

// One clash as text for the agent (and for `whoelse status`).
export function describe(c: Clash): string {
  const n = c.uses.length;
  const calls = `${n} use${n === 1 ? '' : 's'} of ${simpleName(c.symbol)}`;
  switch (c.kind) {
    case 'gone': {
      const what = c.to ? `renamed ${c.symbol} → ${c.to}` : `removed ${c.symbol}`;
      return c.actor === 'them'
        ? `the agent on ${c.other} ${what} (${c.def.file}). You added ${calls}: ${where(c.uses)}. → ${c.to ? `use ${simpleName(c.to)}` : 'stop depending on it'}, or coordinate with ${c.other}.`
        : `you ${what}, but the agent on ${c.other} added ${calls}: ${where(c.uses)}. Their branch breaks when merged with yours. → keep ${simpleName(c.symbol)} as an alias, or coordinate with ${c.other}.`;
    }
    case 'signature':
      return c.actor === 'them'
        ? `the agent on ${c.other} changed ${c.symbol}(${trimParens(c.def.params)}) in ${c.def.file}; it now takes ${arity(c.def)}. Your new calls don't match: ${where(c.uses)}.`
        : `you changed ${c.symbol}(${trimParens(c.def.params)}) to take ${arity(c.def)}, but the agent on ${c.other} added calls that don't match: ${where(c.uses)}.`;
    case 'both-edited':
      return `you and the agent on ${c.other} both changed ${c.symbol} in ${c.def.file}. Expect a merge conflict or two diverging versions.`;
    case 'both-added':
      return `the agent on ${c.other} also added ${c.symbol} (${c.def.file}:${c.def.line}). You may be building the same thing twice.`;
  }
}

// The same clash for a report, naming both branches (`mine` is the branch
// the clash was computed for).
export function describeNeutral(c: Clash, mine: string): string {
  const [changer, user] = c.actor === 'them' ? [c.other, mine] : [mine, c.other];
  const n = c.uses.length;
  const calls = `${n} use${n === 1 ? '' : 's'} of ${simpleName(c.symbol)}`;
  switch (c.kind) {
    case 'gone':
      return `${changer} ${c.to ? `renamed ${c.symbol} → ${c.to}` : `removed ${c.symbol}`} (${c.def.file}); ${user} added ${calls}: ${where(c.uses)}`;
    case 'signature':
      return `${changer} changed ${c.symbol}(${trimParens(c.def.params)}) to take ${arity(c.def)}; ${user} added calls that don't match: ${where(c.uses)}`;
    case 'both-edited':
      return `${mine} and ${c.other} both changed ${c.symbol} in ${c.def.file}`;
    case 'both-added':
      return `${mine} and ${c.other} both added ${c.symbol}`;
  }
}

function trimParens(p: string): string {
  return p.replace(/^\(/, '').replace(/\)$/, '');
}
