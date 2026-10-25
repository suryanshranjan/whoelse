import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reply } from '../src/hooks.js';
import { fixture } from './fixture.js';

function collide(f: { a: string; b: string }): void {
  writeFileSync(join(f.a, 'pay.ts'), readFileSync(join(f.a, 'pay.ts'), 'utf8').replace('chargeCard', 'chargePayment'));
  writeFileSync(join(f.b, 'refunds.ts'), 'import { chargeCard } from "./pay";\nexport const r = () => chargeCard("x", 0);\n');
}

test('claude/codex: told once after an edit, held once at Stop', async () => {
  const f = fixture();
  collide(f);
  const first = (await reply('claude-code', 'PostToolUse', {}, f.b)) as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
  assert.equal(first.hookSpecificOutput?.hookEventName, 'PostToolUse');
  assert.match(first.hookSpecificOutput!.additionalContext, /⚠ the agent on feat-payouts renamed chargeCard → chargePayment/);
  assert.deepEqual(await reply('claude-code', 'PostToolUse', {}, f.b), {}); // not repeated

  const stop = (await reply('codex', 'Stop', {}, f.b)) as { decision?: string; reason?: string };
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason!, /before you finish/);
  assert.deepEqual(await reply('codex', 'Stop', {}, f.b), {}); // held once
  assert.deepEqual(await reply('claude-code', 'Stop', { stop_hook_active: true }, f.a), {});

  // the other side hears about it too, from its own point of view
  const a = (await reply('claude-code', 'UserPromptSubmit', {}, f.a)) as { hookSpecificOutput?: { additionalContext: string } };
  assert.match(a.hookSpecificOutput!.additionalContext, /you renamed chargeCard → chargePayment, but the agent on feat-refunds added 2 uses/);
});

test('antigravity: injected before the model runs, continue at Stop', async () => {
  const f = fixture();
  collide(f);
  const pre = (await reply('antigravity', 'PreInvocation', {}, f.b)) as { injectSteps?: Array<{ ephemeralMessage: string }> };
  assert.match(pre.injectSteps![0].ephemeralMessage, /renamed chargeCard → chargePayment/);
  const stop = (await reply('antigravity', 'Stop', {}, f.b)) as { decision?: string };
  assert.equal(stop.decision, 'continue');
});

test('silent with one worktree or no clash', async () => {
  const f = fixture();
  assert.deepEqual(await reply('claude-code', 'PostToolUse', {}, f.a), {});
});
