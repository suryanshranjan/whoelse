import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSymbols } from '../src/symbols.js';

test('typescript: functions, arrows, classes, methods, types', async () => {
  const s = await parseSymbols(
    'pay.ts',
    [
      'import { log, type Logger } from "./log";',
      'export function chargeCard(id: string, amt: number, note?: string) { return log(id); }',
      'export const refund = (id: string, ...rest: number[]) => chargeCard(id, 1);',
      'export class Payments {',
      '  constructor(private key: string) {}',
      '  charge(a: number, b = 2) { return this.fee(a); }',
      '}',
      'export interface Receipt { id: string }',
      'const LIMIT = 5;',
      'function helper() { function inner() {} return new Payments("k"); }',
    ].join('\n'),
  );
  assert.ok(s);
  const by = Object.fromEntries(s.defs.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(by).sort(), ['LIMIT', 'Payments', 'Payments.charge', 'Receipt', 'chargeCard', 'helper', 'refund']);
  assert.deepEqual([by.chargeCard.minArgs, by.chargeCard.maxArgs], [2, 3]);
  assert.deepEqual([by.refund.minArgs, by.refund.maxArgs], [1, Infinity]);
  assert.deepEqual([by['Payments.charge'].minArgs, by['Payments.charge'].maxArgs], [1, 2]);
  assert.deepEqual([by.Payments.minArgs, by.Payments.maxArgs], [1, 1]); // constructor arity
  assert.equal(by.Receipt.kind, 'type');
  const calls = s.refs.map((r) => `${r.member ? '.' : ''}${r.name}/${r.args}`).sort();
  assert.deepEqual(calls, ['.fee/1', 'Logger/-1', 'Payments/1', 'chargeCard/2', 'log/-1', 'log/1']);
});

test('jsx components count as references', async () => {
  const s = await parseSymbols('a.tsx', 'export function App() { return <Card title="x"><Inner/></Card>; }\n');
  assert.deepEqual(s!.refs.map((r) => r.name).sort(), ['Card', 'Inner']);
});

test('python: defs, methods, arity, calls, from-imports', async () => {
  const s = await parseSymbols(
    'pay.py',
    [
      'from billing.core import charge as do_charge, Ledger',
      'LIMIT = 5',
      'def refund(account, amount=0, *args):',
      '    return do_charge(account)',
      'class Payout:',
      '    def __init__(self, key):',
      '        self.key = key',
      '    @staticmethod',
      '    def send(self, to, amt, *, note=None):',
      '        return self.log(to)',
    ].join('\n'),
  );
  const by = Object.fromEntries(s!.defs.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(by).sort(), ['LIMIT', 'Payout', 'Payout.send', 'refund']);
  assert.deepEqual([by.refund.minArgs, by.refund.maxArgs], [1, Infinity]);
  assert.deepEqual([by.Payout.minArgs, by.Payout.maxArgs], [1, 1]);
  assert.deepEqual([by['Payout.send'].minArgs, by['Payout.send'].maxArgs], [2, 3]);
  assert.deepEqual(s!.refs.map((r) => `${r.member ? '.' : ''}${r.name}/${r.args}`).sort(), ['.log/1', 'Ledger/-1', 'charge/-1', 'do_charge/1']);
});

test('unknown extensions are skipped', async () => {
  assert.equal(await parseSymbols('README.md', '# hi'), null);
});

test('constructor arity lands on the class even after its methods', async () => {
  const s = await parseSymbols('k.ts', 'export class K {\n  a() {}\n  b(x: number) {}\n  constructor(p: string, q: string) {}\n}\n');
  const by = Object.fromEntries(s!.defs.map((d) => [d.name, d]));
  assert.deepEqual([by.K.minArgs, by.K.maxArgs], [2, 2]);
  assert.deepEqual([by['K.b'].minArgs, by['K.b'].maxArgs], [1, 1]);
});
