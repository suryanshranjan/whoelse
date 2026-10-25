// What a source file defines and what it uses, by name, via tree-sitter
// (WASM build, so nothing native to compile). TS/TSX/JS and Python in v1.
//
// Definitions are module-level functions, classes, types and constants plus
// class methods; nested helpers are local and cannot break another agent.
// References are calls, `new`, JSX elements and named imports.

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node } from 'web-tree-sitter';

export type Lang = 'typescript' | 'tsx' | 'javascript' | 'python';
export type DefKind = 'function' | 'method' | 'class' | 'type' | 'const';

export interface Def {
  name: string; // "chargeCard", or "Payments.charge" for a method
  kind: DefKind;
  line: number; // 1-based
  params: string; // normalised parameter list ('' when not callable)
  minArgs: number;
  maxArgs: number; // Infinity with a rest parameter
  bodyHash: string;
  aliasOf?: string; // another name for this definition (export { a as b }, const b = a)
}

export interface Ref {
  name: string; // the called / imported name, without receiver
  member: boolean; // obj.name(...) rather than name(...)
  line: number;
  args: number; // -1 when unknown (spread, JSX, import)
  text: string; // the trimmed source line, to tell old uses from new
}

export interface FileSymbols {
  defs: Def[];
  refs: Ref[];
}

const GRAMMAR: Record<Lang, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
};

export function langFor(path: string): Lang | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') return 'typescript';
  if (ext === 'tsx') return 'tsx';
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript';
  if (ext === 'py') return 'python';
  return null;
}

let ready: Promise<void> | null = null;
const parsers = new Map<Lang, Parser>();

async function parserFor(lang: Lang): Promise<Parser> {
  ready ??= Parser.init();
  await ready;
  let p = parsers.get(lang);
  if (!p) {
    p = new Parser();
    // dist/symbols.js and src/symbols.ts both sit one level below grammars/
    p.setLanguage(await Language.load(fileURLToPath(new URL(`../grammars/${GRAMMAR[lang]}`, import.meta.url))));
    parsers.set(lang, p);
  }
  return p;
}

export async function parseSymbols(path: string, source: string): Promise<FileSymbols | null> {
  const lang = langFor(path);
  if (!lang) return null;
  const tree = (await parserFor(lang)).parse(source);
  if (!tree) return null;
  try {
    const root = tree.rootNode;
    return lang === 'python' ? pythonSymbols(root, source) : jsSymbols(root, source);
  } finally {
    tree.delete();
  }
}

function hash(text: string): string {
  return createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function lineText(lines: string[], row: number): string {
  return norm(lines[row] ?? '');
}

// ---------------------------------------------------------------- JS / TS

const JS_TOP = new Set(['program', 'export_statement']);

function jsArity(params: Node | null): { min: number; max: number } {
  if (!params) return { min: 0, max: 0 };
  if (params.type === 'identifier') return { min: 1, max: 1 }; // x => ...
  let min = 0;
  let max = 0;
  for (const p of params.namedChildren) {
    if (!p) continue;
    if (p.type === 'comment') continue;
    const pattern = p.childForFieldName('pattern');
    if (pattern?.text === 'this') continue; // TS `this` parameter
    const rest = p.type === 'rest_pattern' || pattern?.type === 'rest_pattern';
    if (rest) {
      max = Infinity;
      continue;
    }
    max++;
    const optional =
      p.type === 'optional_parameter' || p.type === 'assignment_pattern' || p.childForFieldName('value') !== null;
    if (!optional) min = max;
  }
  return { min, max };
}

function jsSymbols(root: Node, source: string): FileSymbols {
  const lines = source.split('\n');
  const defs: Def[] = [];
  const refs: Ref[] = [];

  const callable = (name: string, kind: DefKind, fn: Node, at: Node): void => {
    const params = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter');
    const { min, max } = jsArity(params);
    defs.push({
      name,
      kind,
      line: at.startPosition.row + 1,
      params: norm(params?.text ?? ''),
      minArgs: min,
      maxArgs: max,
      bodyHash: hash(fn.childForFieldName('body')?.text ?? fn.text),
    });
  };
  const plain = (name: string, kind: DefKind, at: Node): void => {
    defs.push({ name, kind, line: at.startPosition.row + 1, params: '', minArgs: 0, maxArgs: 0, bodyHash: hash(at.text) });
  };

  const visitTop = (n: Node): void => {
    switch (n.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = n.childForFieldName('name')?.text;
        if (name) callable(name, 'function', n, n);
        return;
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = n.childForFieldName('name')?.text;
        if (!name) return;
        plain(name, 'class', n);
        const body = n.childForFieldName('body');
        for (const m of body?.namedChildren ?? []) {
          if (m?.type !== 'method_definition') continue;
          const mname = m.childForFieldName('name')?.text;
          if (mname && mname !== 'constructor') callable(`${name}.${mname}`, 'method', m, m);
          if (mname === 'constructor') {
            // `new Name(...)` is checked against the constructor's arity
            const cls = defs.find((d) => d.name === name && d.kind === 'class')!;
            const { min, max } = jsArity(m.childForFieldName('parameters'));
            Object.assign(cls, { params: norm(m.childForFieldName('parameters')?.text ?? ''), minArgs: min, maxArgs: max });
          }
        }
        if (!body?.namedChildren.some((m) => m?.type === 'method_definition' && m.childForFieldName('name')?.text === 'constructor')) {
          const cls = defs.find((d) => d.name === name && d.kind === 'class');
          if (cls) cls.maxArgs = Infinity; // implicit or inherited constructor: unknown arity
        }
        return;
      }
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration': {
        const name = n.childForFieldName('name')?.text;
        if (name) plain(name, 'type', n);
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const d of n.namedChildren) {
          if (d?.type !== 'variable_declarator') continue;
          const id = d.childForFieldName('name');
          if (id?.type !== 'identifier') continue;
          const value = d.childForFieldName('value');
          if (value && /^(arrow_function|function_expression|function|generator_function)$/.test(value.type)) {
            callable(id.text, 'function', value, d);
          } else {
            plain(id.text, 'const', d);
            if (value?.type === 'identifier') defs[defs.length - 1].aliasOf = value.text; // const old = renamed
          }
        }
        return;
      }
      case 'export_clause': {
        // export { chargePayment as chargeCard }: the old name lives on
        for (const s of n.namedChildren) {
          if (s?.type !== 'export_specifier') continue;
          const name = s.childForFieldName('name')?.text;
          const alias = s.childForFieldName('alias')?.text;
          if (name && alias && alias !== name) {
            plain(alias, 'const', s);
            defs[defs.length - 1].aliasOf = name;
          }
        }
        return;
      }
      case 'export_statement': {
        for (const c of n.namedChildren) if (c) visitTop(c);
        return;
      }
    }
  };
  for (const n of root.namedChildren) if (n && JS_TOP.has(n.parent?.type ?? '')) visitTop(n);

  const args = (call: Node): number => {
    const a = call.childForFieldName('arguments');
    if (!a) return -1;
    const items = a.namedChildren.filter((x) => x && x.type !== 'comment');
    return items.some((x) => x?.type === 'spread_element') ? -1 : items.length;
  };
  for (const c of root.descendantsOfType(['call_expression', 'new_expression'])) {
    if (!c) continue;
    const fn = c.childForFieldName(c.type === 'new_expression' ? 'constructor' : 'function');
    if (!fn) continue;
    const row = c.startPosition.row;
    if (fn.type === 'identifier') {
      refs.push({ name: fn.text, member: false, line: row + 1, args: args(c), text: lineText(lines, row) });
    } else if (fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      if (prop) refs.push({ name: prop.text, member: true, line: row + 1, args: args(c), text: lineText(lines, row) });
    }
  }
  for (const el of root.descendantsOfType(['jsx_opening_element', 'jsx_self_closing_element'])) {
    const name = el?.childForFieldName('name');
    if (name?.type === 'identifier' && /^[A-Z]/.test(name.text)) {
      const row = el!.startPosition.row;
      refs.push({ name: name.text, member: false, line: row + 1, args: -1, text: lineText(lines, row) });
    }
  }
  for (const s of root.descendantsOfType('import_specifier')) {
    const name = s?.childForFieldName('name');
    if (name) {
      const row = s!.startPosition.row;
      refs.push({ name: name.text, member: false, line: row + 1, args: -1, text: lineText(lines, row) });
    }
  }
  return { defs, refs };
}

// ---------------------------------------------------------------- Python

function pyArity(params: Node | null, method: boolean): { min: number; max: number } {
  let min = 0;
  let max = 0;
  let first = true;
  for (const p of params?.namedChildren ?? []) {
    if (!p) continue;
    if (method && first) {
      first = false;
      const n = p.type === 'identifier' ? p.text : p.namedChildren[0]?.text;
      if (n === 'self' || n === 'cls') continue;
    }
    first = false;
    if (p.type === 'list_splat_pattern' || p.type === 'dictionary_splat_pattern') {
      max = Infinity;
      continue;
    }
    if (p.type === 'keyword_separator' || p.type === 'positional_separator') continue;
    if (p.type === 'typed_parameter' && /^(list_splat_pattern|dictionary_splat_pattern)$/.test(p.namedChildren[0]?.type ?? '')) {
      max = Infinity;
      continue;
    }
    max++;
    if (p.type !== 'default_parameter' && p.type !== 'typed_default_parameter') min = max;
  }
  return { min, max };
}

function pythonSymbols(root: Node, source: string): FileSymbols {
  const lines = source.split('\n');
  const defs: Def[] = [];
  const refs: Ref[] = [];

  const unwrap = (n: Node): Node => (n.type === 'decorated_definition' ? n.childForFieldName('definition') ?? n : n);
  const fnDef = (fn: Node, name: string, kind: DefKind, method: boolean): void => {
    const params = fn.childForFieldName('parameters');
    const { min, max } = pyArity(params, method);
    defs.push({
      name,
      kind,
      line: fn.startPosition.row + 1,
      params: norm(params?.text ?? ''),
      minArgs: min,
      maxArgs: max,
      bodyHash: hash(fn.childForFieldName('body')?.text ?? fn.text),
    });
  };

  for (const top of root.namedChildren) {
    if (!top) continue;
    const n = unwrap(top);
    if (n.type === 'function_definition') {
      const name = n.childForFieldName('name')?.text;
      if (name) fnDef(n, name, 'function', false);
    } else if (n.type === 'class_definition') {
      const name = n.childForFieldName('name')?.text;
      if (!name) continue;
      const cls: Def = { name, kind: 'class', line: n.startPosition.row + 1, params: '', minArgs: 0, maxArgs: Infinity, bodyHash: hash(n.text) };
      defs.push(cls);
      for (const m0 of n.childForFieldName('body')?.namedChildren ?? []) {
        if (!m0) continue;
        const m = unwrap(m0);
        if (m.type !== 'function_definition') continue;
        const mname = m.childForFieldName('name')?.text;
        if (!mname) continue;
        if (mname === '__init__') {
          const { min, max } = pyArity(m.childForFieldName('parameters'), true);
          Object.assign(cls, { params: norm(m.childForFieldName('parameters')?.text ?? ''), minArgs: min, maxArgs: max });
        } else if (!mname.startsWith('__')) {
          fnDef(m, `${name}.${mname}`, 'method', true);
        }
      }
    } else if (n.type === 'expression_statement') {
      const a = n.namedChildren[0];
      const left = a?.type === 'assignment' ? a.childForFieldName('left') : null;
      if (left?.type === 'identifier') {
        const right = a?.childForFieldName('right');
        defs.push({ name: left.text, kind: 'const', line: n.startPosition.row + 1, params: '', minArgs: 0, maxArgs: 0, bodyHash: hash(n.text), ...(right?.type === 'identifier' ? { aliasOf: right.text } : {}) });
      }
    }
  }

  for (const c of root.descendantsOfType('call')) {
    if (!c) continue;
    const fn = c.childForFieldName('function');
    const a = c.childForFieldName('arguments');
    const items = a?.namedChildren.filter((x) => x && x.type !== 'comment') ?? [];
    const n = items.some((x) => x && /splat/.test(x.type)) ? -1 : items.length;
    const row = c.startPosition.row;
    if (fn?.type === 'identifier') refs.push({ name: fn.text, member: false, line: row + 1, args: n, text: lineText(lines, row) });
    else if (fn?.type === 'attribute') {
      const attr = fn.childForFieldName('attribute');
      if (attr) refs.push({ name: attr.text, member: true, line: row + 1, args: n, text: lineText(lines, row) });
    }
  }
  for (const s of root.descendantsOfType('import_from_statement')) {
    if (!s) continue;
    for (const nm of s.childrenForFieldName('name')) {
      if (!nm) continue;
      const id = nm.type === 'aliased_import' ? nm.childForFieldName('name') : nm;
      const name = id?.text.split('.').pop();
      if (name) refs.push({ name, member: false, line: s.startPosition.row + 1, args: -1, text: lineText(lines, s.startPosition.row) });
    }
  }
  return { defs, refs };
}
