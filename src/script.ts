// Reads Ogre scripts (.material, .program and similar) into a tree of objects and properties,
// and resolves inheritance (`material B : A`, abstract objects) and variables (`set $name value`)
// the way Ogre's script compiler does.

export interface ScriptProperty {
  object: false;
  name: string;
  values: string[];
  line: number;
}

export interface ScriptObject {
  object: true;
  /** The object type, such as material, technique, pass or texture_unit. */
  type: string;
  name: string;
  /** The object it inherits from, if any. */
  parent: string | null;
  abstract: boolean;
  /** Header words after the name, such as a program's language. */
  extra: string[];
  children: ScriptNode[];
  line: number;
  file: string;
}

export type ScriptNode = ScriptProperty | ScriptObject;

interface Token {
  text: string;
  quoted: boolean;
  line: number;
}

const NEWLINE = '\n';

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  const n = source.length;
  const push = (text: string, quoted = false) => tokens.push({ text, quoted, line });
  while (i < n) {
    const c = source[i]!;
    if (c === '\n') {
      push(NEWLINE);
      line++;
      i++;
    } else if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i++;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let j = i; j < stop; j++) if (source[j] === '\n') line++;
      i = stop;
    } else if (c === '{' || c === '}') {
      push(c);
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < n && source[j] !== '"' && source[j] !== '\n') {
        if (source[j] === '\\' && j + 1 < n && source[j + 1] !== '\n') j++;
        text += source[j];
        j++;
      }
      push(text, true);
      i = source[j] === '"' ? j + 1 : j;
    } else {
      let j = i;
      while (j < n && !/[\s{}"]/.test(source[j]!)) {
        if (source[j] === '/' && (source[j + 1] === '/' || source[j + 1] === '*')) break;
        j++;
      }
      push(source.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

/** Object types whose header is `type name [: parent]`. Other objects are read the same way. */
function header(tokens: Token[], file: string, line: number, children: ScriptNode[]): ScriptObject {
  const words: Token[] = [];
  // Split "name:" and ":parent" so that `material A: B` reads like `material A : B`.
  for (const t of tokens) {
    if (t.quoted || t.text === ':' || !t.text.includes(':') || /^[a-z]:[\\/]/i.test(t.text)) words.push(t);
    else if (t.text.endsWith(':')) words.push({ ...t, text: t.text.slice(0, -1) }, { ...t, text: ':' });
    else if (t.text.startsWith(':')) words.push({ ...t, text: ':' }, { ...t, text: t.text.slice(1) });
    else words.push(t);
  }
  let abstract = false;
  if (words[0]?.text === 'abstract') {
    abstract = true;
    words.shift();
  }
  const type = words[0]?.text ?? '';
  let name = '';
  let parent: string | null = null;
  const extra: string[] = [];
  let k = 1;
  if (k < words.length && !(words[k]!.text === ':' && !words[k]!.quoted)) name = words[k++]!.text;
  for (; k < words.length; k++) {
    const w = words[k]!;
    if (w.text === ':' && !w.quoted && k + 1 < words.length) parent = words[++k]!.text;
    else extra.push(w.text);
  }
  return { object: true, type, name, parent, abstract, extra, children, line, file };
}

/** Parses a script into its top-level objects and properties. */
export function parseScript(source: string, file = ''): ScriptNode[] {
  const tokens = tokenize(source);
  let i = 0;
  const skipNewlines = () => {
    while (i < tokens.length && tokens[i]!.text === NEWLINE && !tokens[i]!.quoted) i++;
  };
  const isPunct = (t: Token | undefined, p: string) => t !== undefined && !t.quoted && t.text === p;

  function block(nested: boolean): ScriptNode[] {
    const nodes: ScriptNode[] = [];
    for (;;) {
      skipNewlines();
      if (i >= tokens.length) return nodes;
      if (isPunct(tokens[i], '}')) {
        i++;
        if (nested) return nodes;
        continue;
      }
      if (isPunct(tokens[i], '{')) {
        // A block without a header: read and drop it.
        i++;
        block(true);
        continue;
      }
      const line = tokens[i]!.line;
      const statement: Token[] = [];
      while (i < tokens.length && !isPunct(tokens[i], NEWLINE) && !isPunct(tokens[i], '{') && !isPunct(tokens[i], '}')) {
        statement.push(tokens[i++]!);
      }
      const save = i;
      skipNewlines();
      if (isPunct(tokens[i], '{')) {
        i++;
        const children = block(true);
        nodes.push(header(statement, file, line, children));
      } else {
        i = save;
        const [first, ...rest] = statement;
        if (first) nodes.push({ object: false, name: first.text, values: rest.map((t) => t.text), line });
      }
    }
  }

  return block(false);
}

function clone(node: ScriptObject): ScriptObject {
  return { ...node, extra: [...node.extra], children: node.children.map((c) => (c.object ? clone(c) : { ...c, values: [...c.values] })) };
}

/**
 * Keeps the objects of a set of scripts and resolves inheritance between them. Materials can
 * inherit from materials in other scripts, so all of them are added before any is resolved.
 */
export class ScriptRegistry {
  private readonly named = new Map<string, ScriptObject>();
  private readonly lower = new Map<string, ScriptObject>();
  readonly objects: ScriptObject[] = [];
  readonly imports: string[] = [];
  readonly warnings: string[] = [];

  add(source: string, file = ''): ScriptObject[] {
    const added: ScriptObject[] = [];
    for (const node of parseScript(source, file)) {
      if (!node.object) {
        if (node.name === 'import') {
          const from = node.values.indexOf('from');
          const target = from >= 0 ? node.values[from + 1] : node.values[node.values.length - 1];
          if (target) this.imports.push(target);
        }
        continue;
      }
      this.objects.push(node);
      added.push(node);
      if (node.name) {
        const key = `${node.type}:${node.name}`;
        if (this.named.has(key) && !node.abstract) this.warnings.push(`${node.type} ${node.name} is defined twice; the last one is used`);
        this.named.set(key, node);
        this.lower.set(key.toLowerCase(), node);
      }
    }
    return added;
  }

  /** Finds a top-level object by type and name, matching case only if there's a choice. */
  find(type: string, name: string): ScriptObject | undefined {
    const key = `${type}:${name}`;
    return this.named.get(key) ?? this.lower.get(key.toLowerCase());
  }

  /** The object with its inheritance applied and its variables substituted. */
  resolve(object: ScriptObject): ScriptObject {
    return substitute(this.inherit(object, new Set()), new Map());
  }

  private inherit(object: ScriptObject, seen: Set<ScriptObject>): ScriptObject {
    if (seen.has(object)) {
      this.warnings.push(`${object.type} ${object.name} inherits from itself`);
      return clone(object);
    }
    seen.add(object);
    let result: ScriptObject;
    if (object.parent) {
      const base = this.find(object.type, object.parent);
      if (!base) {
        this.warnings.push(`${object.type} ${object.name || '(unnamed)'} inherits from ${object.parent}, which wasn't found`);
        result = { ...clone(object), children: [] };
      } else {
        result = { ...this.inherit(base, seen), name: object.name, parent: null, abstract: object.abstract, line: object.line, file: object.file };
      }
    } else {
      result = { ...clone(object), children: [] };
    }
    seen.delete(object);
    this.overlay(result, object, seen);
    return result;
  }

  /** Adds `source`'s children to `dest`: properties are appended, and objects replace or extend those they match. */
  private overlay(dest: ScriptObject, source: ScriptObject, seen: Set<ScriptObject>): void {
    const counts = new Map<string, number>();
    for (const node of source.children) {
      if (!node.object) {
        dest.children.push({ ...node, values: [...node.values] });
        continue;
      }
      const index = counts.get(node.type) ?? 0;
      counts.set(node.type, index + 1);
      // Named objects match by name; unnamed ones by their position among objects of the type.
      const sameType = dest.children.filter((c): c is ScriptObject => c.object && c.type === node.type);
      const match = node.name ? sameType.find((c) => c.name === node.name) : node.parent ? undefined : sameType[index];
      if (match && !node.parent) {
        this.overlay(match, node, seen);
      } else {
        const resolved = this.inherit(node, seen);
        if (match) dest.children[dest.children.indexOf(match)] = resolved;
        else dest.children.push(resolved);
      }
    }
  }
}

function substitute(object: ScriptObject, outer: Map<string, string>): ScriptObject {
  const scope = new Map(outer);
  for (const node of object.children) {
    if (!node.object && node.name === 'set' && node.values.length >= 2) {
      scope.set(node.values[0]!.replace(/^\$/, ''), node.values.slice(1).join(' '));
    }
  }
  const replace = (value: string) => (value.startsWith('$') && scope.has(value.slice(1)) ? scope.get(value.slice(1))!.split(' ') : [value]);
  object.children = object.children.map((node) => {
    if (node.object) return substitute(node, scope);
    if (node.name === 'set') return node;
    return { ...node, values: node.values.flatMap(replace) };
  });
  return object;
}
