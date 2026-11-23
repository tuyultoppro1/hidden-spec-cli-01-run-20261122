// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 (command line, output and exit codes, safe paths, format
// detection, JSON edits, all-or-nothing write) come from the kit's starting point.
// Sections 5 to 8 (three-tier matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches) and the `R old -> new` move output line are implemented below.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, in patch order. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Section 3 helpers: a file's lines, its line break, its final break */
/* ------------------------------------------------------------------ */

interface FileParts {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const parts = text.split(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

/* --------------------------------------------------------------- */
/* Section 5: matching lines at three tiers, and building the new   */
/* lines (context lines from the file, tier-2 re-indentation).      */
/* --------------------------------------------------------------- */

const leadingWS = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function matchLine(fileLine: string, patLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patLine;
  if (tier === 1) return trimTrail(fileLine) === trimTrail(patLine);
  return trimBoth(fileLine) === trimBoth(patLine);
}

/** 0-based positions at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(0, from); i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!matchLine(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, O, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NItem {
  text: string;
  ctx: boolean;
  /** Index into O of the context line this item mirrors; -1 when not a context line. */
  oIndex: number;
}

function buildNew(fileLines: string[], pos: number, O: string[], N: NItem[], tier: number): string[] {
  const out: string[] = [];
  const F = O.length > 0 ? leadingWS(fileLines[pos]!) : '';
  const P = O.length > 0 ? leadingWS(O[0]!) : '';
  for (const it of N) {
    if (it.ctx) {
      out.push(fileLines[pos + it.oIndex]!);
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Section 9: JSON edits (from the kit's starting point, unchanged).  */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                          */
/* ------------------------------------------------------------------ */

interface Hunk {
  /** A: the 1-based old start from the header. */
  a: number;
  body: string[];
}

interface USection {
  oldP: string | null; // null: /dev/null
  newP: string | null; // null: /dev/null
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed. */
function unifiedPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

/** Split a hunk body into its old lines O and its new lines N (with context flags). */
function hunkON(h: Hunk): { O: string[]; N: NItem[] } {
  const O: string[] = [];
  const N: NItem[] = [];
  for (const bl of h.body) {
    if (bl === '') {
      O.push('');
      N.push({ text: '', ctx: true, oIndex: O.length - 1 });
    } else if (bl[0] === ' ') {
      const t = bl.slice(1);
      O.push(t);
      N.push({ text: t, ctx: true, oIndex: O.length - 1 });
    } else if (bl[0] === '-') {
      O.push(bl.slice(1));
    } else if (bl[0] === '+') {
      N.push({ text: bl.slice(1), ctx: false, oIndex: -1 });
    }
    // '\' lines are handled by hunkNoEol and carry no text.
  }
  return { O, N };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(h: Hunk): boolean {
  const b = h.body;
  let last = -1;
  for (let k = 0; k < b.length; k++) {
    const c = b[k]!;
    if (c === '' || c[0] === ' ' || c[0] === '+') last = k;
  }
  if (last < 0) return false;
  const next = b[last + 1];
  return next !== undefined && next[0] === '\\';
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  // Per-section path sources; the ---/+++ pair wins over rename, which wins over diff --git.
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renOld: string | null | undefined;
  let renNew: string | null | undefined;
  let gitOld: string | null | undefined;
  let gitNew: string | null | undefined;
  let hasPair = false;
  let phase: 'header' | 'body' = 'header';
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const n = lines.length;

  const closeSection = (): void => {
    if (cur === null) return;
    cur.oldP = pairOld !== undefined ? pairOld : renOld !== undefined ? renOld : gitOld !== undefined ? gitOld : null;
    cur.newP = pairNew !== undefined ? pairNew : renNew !== undefined ? renNew : gitNew !== undefined ? gitNew : null;
    sections.push(cur);
    cur = null;
  };
  const startSection = (git: { oldP: string; newP: string } | null, pair: { oldP: string | null; newP: string | null } | null): void => {
    closeSection();
    cur = { oldP: null, newP: null, create: false, del: false, hunks: [] };
    pairOld = pair !== null ? pair.oldP : undefined;
    pairNew = pair !== null ? pair.newP : undefined;
    renOld = undefined;
    renNew = undefined;
    gitOld = git !== null ? git.oldP : undefined;
    gitNew = git !== null ? git.newP : undefined;
    hasPair = pair !== null;
    phase = 'header';
  };

  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      startSection({ oldP: m[1]!, newP: m[2]! }, null);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = unifiedPath(line.slice(4));
      const newP = unifiedPath(lines[i + 1]!.slice(4));
      if (cur !== null && phase === 'header' && !hasPair) {
        pairOld = oldP;
        pairNew = newP;
        hasPair = true;
      } else {
        startSection(null, { oldP, newP });
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j += 1;
        } else break;
      }
      // Empty lines at the end of a body are not part of it (context lines with empty text).
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last === '' || last === ' ') body.pop();
        else break;
      }
      cur.hunks.push({ a, body });
      phase = 'body';
      i = j;
      continue;
    }
    if (cur !== null && phase === 'header') {
      if (line.startsWith('--- ')) {
        // Not followed by a +++ line (that case is handled above).
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      // index, old/new mode, similarity/dissimilarity index, Index: and any other line: ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i += 1;
  }
  closeSection();
  return sections.map((sec) => makeUnifiedEdit(sec, strict));
}

function makeUnifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldP;
    const newP = sec.newP;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    let kind: 'create' | 'delete' | 'move' | 'change' | 'noop';
    if (newP === null && oldP !== null) kind = 'delete';
    else if (oldP === null && newP !== null) kind = 'create';
    else if (sec.create && newP !== null) kind = 'create';
    else if (sec.del && oldP !== null) kind = 'delete';
    else if (oldP !== null && newP !== null && oldP !== newP) kind = 'move';
    else if (oldP !== null) kind = 'change';
    else kind = 'noop';

    if (kind === 'noop') return;
    if (kind === 'create') {
      const target = newP!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const bl of h.body) if (bl[0] === '+') plus.push(bl.slice(1));
      }
      let noEol = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const b = sec.hunks[hi]!.body;
        for (let k = b.length - 1; k >= 0; k--) {
          if (b[k]![0] === '+') {
            const next = b[k + 1];
            noEol = next !== undefined && next[0] === '\\';
            break outer;
          }
        }
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const target = oldP!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    // Change or move: apply the hunks in order to the old file's lines.
    const src = oldP!;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (kind === 'move' && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const parts = splitFile(before);
    const lines = parts.lines;
    let ends = parts.ends;
    const br = parts.br;
    let d = 0;
    for (const h of sec.hunks) {
      const { O, N } = hunkON(h);
      if (O.length === 0) {
        let ins = h.a + d;
        if (ins < 0) ins = 0;
        if (ins > lines.length) ins = lines.length;
        const add = N.map((it) => it.text);
        const touchesEnd = ins === lines.length;
        lines.splice(ins, 0, ...add);
        if (touchesEnd) ends = !hunkNoEol(h);
        d += N.length;
      } else {
        const found = findTier(lines, O, strict);
        if (!found) throw new Fail('no-match', src);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.positions) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const pos = best;
        const touchesEnd = pos + O.length === lines.length;
        const add = buildNew(lines, pos, O, N, found.tier);
        lines.splice(pos, O.length, ...add);
        if (touchesEnd) ends = !hunkNoEol(h);
        d += N.length - O.length;
      }
    }
    const out = joinFile(lines, br, ends);
    if (kind === 'move') {
      tree.now.set(src, null);
      tree.now.set(newP!, out);
      tree.moves.push([src, newP!]);
    } else {
      tree.now.set(src, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                  */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  old: string[];
  next: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1; // index of the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let sep = -1;
    for (let j = s + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, sep), next: lines.slice(sep + 1, rep) });
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return blocks.map((b) => makeSREdit(b, strict));
}

function makeSREdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.next.length === 0 ? '' : b.next.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const parts = splitFile(before);
    const lines = parts.lines;
    const found = findTier(lines, b.old, strict);
    if (!found) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const nItems: NItem[] = b.next.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const add = buildNew(lines, pos, b.old, nItems, found.tier);
    lines.splice(pos, b.old.length, ...add);
    tree.now.set(p, joinFile(lines, parts.br, parts.ends));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                            */
/* ------------------------------------------------------------------ */

interface VChunk {
  /** Null: no anchor (empty @@ text is no anchor). */
  anchor: string | null;
  eof: boolean;
  /** Raw body lines, blank lines at either end stripped when read. */
  lines: string[];
}

function chunkON(c: VChunk): { O: string[]; N: NItem[] } {
  let a = 0;
  while (a < c.lines.length && blank(c.lines[a]!)) a += 1;
  let b = c.lines.length;
  while (b > a && blank(c.lines[b - 1]!)) b -= 1;
  const ls = c.lines.slice(a, b);
  const O: string[] = [];
  const N: NItem[] = [];
  for (const bl of ls) {
    if (bl === '') {
      O.push('');
      N.push({ text: '', ctx: true, oIndex: O.length - 1 });
    } else if (bl[0] === ' ') {
      const t = bl.slice(1);
      O.push(t);
      N.push({ text: t, ctx: true, oIndex: O.length - 1 });
    } else if (bl[0] === '-') {
      O.push(bl.slice(1));
    } else if (bl[0] === '+') {
      N.push({ text: bl.slice(1), ctx: false, oIndex: -1 });
    }
  }
  return { O, N };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const n = last; // index of the *** End Patch line: sections end before it
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < n) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      i += 1;
      const content: string[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          content.push(l.slice(1));
          i += 1;
        } else if (blank(l)) {
          content.push('');
          i += 1;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i += 1;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateLine = i + 1;
      i += 1;
      while (i < n && blank(lines[i]!)) i += 1;
      let moveTo: string | null = null;
      if (i < n && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunkStarted = false;
      while (i < n) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, lines: [] };
          chunks.push(cur);
          firstChunkStarted = true;
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i += 1;
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
        if (blank(l)) {
          if (cur !== null) cur.lines.push(l);
          i += 1;
          continue;
        }
        if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (!firstChunkStarted) {
              cur = { anchor: null, eof: false, lines: [] };
              chunks.push(cur);
              firstChunkStarted = true;
            } else {
              throw new Exit2(`error: parse ${i + 1}`);
            }
          }
          cur.lines.push(l);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeV4AUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function makeV4AUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    const lines = parts.lines;
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const c of chunks) {
      const { O, N } = chunkON(c);
      if (c.anchor !== null && c.anchor !== '') {
        let foundIdx = -1;
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (matchLine(lines[k]!, c.anchor, t)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      if (O.length === 0) {
        const ins = c.eof ? lines.length : cursor;
        const add = N.map((it) => it.text);
        lines.splice(ins, 0, ...add);
        cursor = ins + add.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        for (const t of tiers) {
          const occ = occurrences(lines, O, t, cursor);
          const cand = c.eof ? occ.filter((p) => p + O.length === lines.length) : occ;
          if (cand.length > 0) {
            found = { tier: t, pos: cand[0]! };
            break;
          }
        }
        if (!found) throw new Fail('no-match', path);
        const add = buildNew(lines, found.pos, O, N, found.tier);
        lines.splice(found.pos, O.length, ...add);
        cursor = found.pos + add.length;
      }
    }
    const out = joinFile(lines, parts.br, parts.ends);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 1, 2 and 10: invocation, output, exit codes, atomicity.    */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves: Array<[string, string]> = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One output row per changed path, in byte order of the paths; a successful
  // move edit's D + A pair is replaced by one R line sorted by its new path.
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      const di = rows.findIndex((r) => r.line === `D ${oldP}`);
      const ai = rows.findIndex((r) => r.line === `A ${newP}`);
      // Remove the larger index first so the other index stays valid.
      for (const idx of [di, ai].sort((a, b) => b - a)) {
        if (idx >= 0) rows.splice(idx, 1);
      }
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
