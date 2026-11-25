// A small XML reader for .mesh.xml and .scene files, so the package doesn't depend on DOMParser
// and runs the same in browsers, workers and Node.

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Text content directly inside the element, trimmed. */
  text: string;
}

export class XmlSyntaxError extends Error {
  override name = 'XmlSyntaxError';
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

/** Parses an XML document and returns its root element. */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  const texts: string[][] = [[]];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      texts[texts.length - 1]!.push(source.slice(i));
      break;
    }
    if (lt > i) texts[texts.length - 1]!.push(source.slice(i, lt));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const stop = end < 0 ? n : end;
      texts[texts.length - 1]!.push(source.slice(lt + 9, stop).replace(/&/g, '&amp;').replace(/</g, '&lt;'));
      i = end < 0 ? n : end + 3;
    } else if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
    } else if (source.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in brackets.
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const c = source[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt);
      if (end < 0) throw new XmlSyntaxError('Unterminated closing tag');
      const name = source.slice(lt + 2, end).trim();
      const element = stack.pop();
      const text = texts.pop();
      if (!element || element === root || element.name !== name) {
        throw new XmlSyntaxError(`Unexpected </${name}>${element && element !== root ? `, expected </${element.name}>` : ''}`);
      }
      element.text = decode(text!.join('')).trim();
      i = end + 1;
    } else {
      // Start tag: name, then attributes, then > or />.
      let j = lt + 1;
      while (j < n && !/[\s/>]/.test(source[j]!)) j++;
      const name = source.slice(lt + 1, j);
      if (!name) throw new XmlSyntaxError(`Malformed tag at offset ${lt}`);
      const attributes: Record<string, string> = {};
      let selfClosing = false;
      for (;;) {
        while (j < n && /\s/.test(source[j]!)) j++;
        if (j >= n) throw new XmlSyntaxError(`Unterminated <${name}>`);
        if (source[j] === '>') {
          j++;
          break;
        }
        if (source[j] === '/' && source[j + 1] === '>') {
          selfClosing = true;
          j += 2;
          break;
        }
        const start = j;
        while (j < n && !/[\s=/>]/.test(source[j]!)) j++;
        const key = source.slice(start, j);
        while (j < n && /\s/.test(source[j]!)) j++;
        if (source[j] !== '=') {
          attributes[key] = '';
          continue;
        }
        j++;
        while (j < n && /\s/.test(source[j]!)) j++;
        const quote = source[j];
        if (quote === '"' || quote === "'") {
          const end = source.indexOf(quote, j + 1);
          if (end < 0) throw new XmlSyntaxError(`Unterminated attribute ${key} in <${name}>`);
          attributes[key] = decode(source.slice(j + 1, end));
          j = end + 1;
        } else {
          const vs = j;
          while (j < n && !/[\s>]/.test(source[j]!)) j++;
          attributes[key] = decode(source.slice(vs, j));
        }
      }
      const element: XmlElement = { name, attributes, children: [], text: '' };
      stack[stack.length - 1]!.children.push(element);
      if (!selfClosing) {
        stack.push(element);
        texts.push([]);
      }
      i = j;
    }
  }
  if (stack.length > 1) throw new XmlSyntaxError(`Missing </${stack[stack.length - 1]!.name}>`);
  const top = root.children[0];
  if (!top) throw new XmlSyntaxError('No root element');
  return top;
}

/** The element's attribute, matched without regard to case. */
export function attr(element: XmlElement, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = element.attributes[name];
    if (value !== undefined) return value;
  }
  const lower = names.map((name) => name.toLowerCase());
  for (const [key, value] of Object.entries(element.attributes)) {
    if (lower.includes(key.toLowerCase())) return value;
  }
  return undefined;
}

export function numAttr(element: XmlElement, names: string | string[], fallback: number): number {
  const value = attr(element, ...(Array.isArray(names) ? names : [names]));
  if (value === undefined || value.trim() === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function boolAttr(element: XmlElement, names: string | string[], fallback: boolean): boolean {
  const value = attr(element, ...(Array.isArray(names) ? names : [names]));
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

/** Child elements with the name, matched without regard to case. */
export function childrenNamed(element: XmlElement, ...names: string[]): XmlElement[] {
  const lower = names.map((name) => name.toLowerCase());
  return element.children.filter((child) => lower.includes(child.name.toLowerCase()));
}

export function child(element: XmlElement, ...names: string[]): XmlElement | undefined {
  return childrenNamed(element, ...names)[0];
}
