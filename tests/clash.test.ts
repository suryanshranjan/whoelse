import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { worktreeDelta } from '../src/delta.js';
import { describe as say, findClashes } from '../src/clash.js';
import { worktrees } from '../src/git.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

// main repo with pay.ts + api.ts, and two worktrees A and B branched from main
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

async function deltas(f: { a: string; b: string }) {
  const all = worktrees(f.a);
  const wa = all.find((w) => w.branch === 'feat-payouts')!;
  const wb = all.find((w) => w.branch === 'feat-refunds')!;
  return { a: await worktreeDelta(wa), b: await worktreeDelta(wb) };
}

test('rename on one side, new calls on the other: both sides are told', async () => {
  const f = fixture();
  // A renames chargeCard and updates the existing caller
  writeFileSync(join(f.a, 'pay.ts'), readFileSync(join(f.a, 'pay.ts'), 'utf8').replace('chargeCard', 'chargePayment'));
  writeFileSync(join(f.a, 'api.ts'), readFileSync(join(f.a, 'api.ts'), 'utf8').replaceAll('chargeCard', 'chargePayment'));
  // B adds a new module that calls chargeCard (uncommitted) and commits one more call
  writeFileSync(join(f.b, 'refunds.ts'), 'import { chargeCard } from "./pay";\nexport function refund(id: string) {\n  chargeCard(id, -1);\n  return chargeCard(id, 0);\n}\n');

  const { a, b } = await deltas(f);
  assert.deepEqual(a.renamed.map((r) => [r.name, r.to]), [['chargeCard', 'chargePayment']]);
  assert.equal(b.uses.filter((u) => u.name === 'chargeCard').length, 3); // import + 2 calls

  const forB = findClashes(b, a);
  assert.equal(forB.length, 1);
  assert.equal(forB[0].kind, 'gone');
  assert.equal(forB[0].actor, 'them');
  assert.match(say(forB[0]), /the agent on feat-payouts renamed chargeCard → chargePayment \(pay\.ts\)\. You added 3 uses of chargeCard: refunds\.ts:1, refunds\.ts:3, refunds\.ts:4\. → use chargePayment/);

  const forA = findClashes(a, b);
  assert.equal(forA.length, 1);
  assert.equal(forA[0].actor, 'me');
  assert.match(say(forA[0]), /you renamed chargeCard → chargePayment, but the agent on feat-refunds added 3 uses/);
});

test('signature change: only calls that no longer fit are reported', async () => {
  const f = fixture();
  writeFileSync(join(f.a, 'pay.ts'), 'export function chargeCard(id: string, amt: number, currency: string) {\n  return id + amt + currency;\n}\n');
  writeFileSync(join(f.b, 'refunds.ts'), 'import { chargeCard } from "./pay";\nchargeCard("a", 1);\nchargeCard("b", 2, "INR");\n');
  const { a, b } = await deltas(f);
  const forB = findClashes(b, a);
  assert.equal(forB.length, 1);
  assert.equal(forB[0].kind, 'signature');
  assert.deepEqual(forB[0].uses.map((u) => u.line), [2]);
  assert.match(say(forB[0]), /changed chargeCard\(id: string, amt: number, currency: string\) in pay\.ts; it now takes 3 arguments\. Your new calls don't match: refunds\.ts:2/);
});

test('soft: both edited the same function, both added the same helper', async () => {
  const f = fixture();
  writeFileSync(join(f.a, 'pay.ts'), 'export function chargeCard(id: string, amt: number) {\n  return id + amt + 1;\n}\nexport function toPaise(r: number) { return r * 100; }\n');
  writeFileSync(join(f.b, 'pay.ts'), 'export function chargeCard(id: string, amt: number) {\n  return id + amt + 2;\n}\n');
  writeFileSync(join(f.b, 'money.ts'), 'export function toPaise(rupees: number) { return Math.round(rupees * 100); }\n');
  const { a, b } = await deltas(f);
  const kinds = findClashes(b, a).map((c) => `${c.kind}:${c.symbol}`).sort();
  assert.deepEqual(kinds, ['both-added:toPaise', 'both-edited:chargeCard']);
});

test('no clash when the other side only touched unrelated code', async () => {
  const f = fixture();
  writeFileSync(join(f.a, 'pay.ts'), readFileSync(join(f.a, 'pay.ts'), 'utf8').replace('chargeCard', 'chargePayment'));
  writeFileSync(join(f.b, 'notes.ts'), 'export const n = 1;\n');
  const { a, b } = await deltas(f);
  assert.deepEqual(findClashes(b, a), []);
});
