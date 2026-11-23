// mend: one patch tool for every AI edit format (hidden-spec-cli-01).
// Node 22, stdlib only. Entry: run(args) -> { code, out }.

import { readFileSync, writeFileSync, mkdirSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

function rstrip(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

// Patch/file text -> lines: split on '\n', strip one trailing '\r' per line,
// drop the empty piece after a final '\n'. Empty text -> no lines.
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

interface FileRec {
  lines: string[];
  brk: '\r\n' | '\n';
  ends: boolean;
}

// Text -> lines + break kind + final-break flag. Round-trips via serializeText.
function parseText(text: string): FileRec {
  let brk: '\r\n' | '\n' = '\n';
  const i = text.indexOf('\n');
  if (i > 0 && text[i - 1] === '\r') brk = '\r\n';
  const ends = text.length > 0 && text.endsWith(brk);
  const lines = text === '' ? [] : (ends ? text.slice(0, -brk.length) : text).split(brk);
  return { lines, brk, ends };
}

function serializeText(f: FileRec): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.ends ? f.brk : '');
}

// SPEC section 3: safe path rules.
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------- 3-tier line matching (SPEC section 5) ----------

function trimEndST(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimBothST(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimBothST(a) === trimBothST(b);
}

// All start positions where O matches lines at the given tier.
function findOcc(lines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierEq(lines[i + j], o[j], tier)) { good = false; break; }
    }
    if (good) res.push(i);
  }
  return res;
}

// First tier (0, then 1, then 2; strict -> only 0) with >= 1 occurrence.
function firstTierOcc(lines: string[], o: string[], strict: boolean, from: number, endOnly = false): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = findOcc(lines, o, t, from);
    if (endOnly) pos = pos.filter((p) => p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// One new line: text from the patch, or a context line taken from the file.
interface NSpec {
  text: string;
  ctx: boolean;
  oIdx: number;
}

// Build replacement lines: context lines come from the file; other lines are
// re-indented only at tier 2 (SPEC section 5).
function buildNewLines(fileLines: string[], pos: number, oTexts: string[], n: NSpec[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && oTexts.length > 0) {
    f = /^[ \t]*/.exec(fileLines[pos])?.[0] ?? '';
    p = /^[ \t]*/.exec(oTexts[0])?.[0] ?? '';
  }
  return n.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx];
    let s = e.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    return s;
  });
}

function replaceAt(lines: string[], pos: number, oldLen: number, next: string[]): string[] {
  return [...lines.slice(0, pos), ...next, ...lines.slice(pos + oldLen)];
}

// ---------- in-memory tree + edit plumbing (SPEC section 10) ----------

type EditResult =
  | { ok: true; move?: { old: string; new: string } }
  | { ok: false; code: string; path: string };

interface Edit {
  apply: (t: Tree, strict: boolean) => EditResult;
}

function fail(code: string, path: string): EditResult {
  return { ok: false, code, path };
}

function okEdit(move?: { old: string; new: string }): EditResult {
  return { ok: true, move };
}

interface Change {
  path: string;
  kind: 'A' | 'D' | 'M';
  rec: FileRec | null;
}

class Tree {
  private cur = new Map<string, FileRec | null>();
  private init = new Map<string, FileRec | null>();

  get(path: string): FileRec | null {
    if (this.cur.has(path)) return this.cur.get(path) ?? null;
    let rec: FileRec | null = null;
    try {
      rec = parseText(readFileSync(path, 'utf8'));
    } catch {
      rec = null;
    }
    this.cur.set(path, rec);
    this.init.set(path, rec === null ? null : { lines: [...rec.lines], brk: rec.brk, ends: rec.ends });
    return rec;
  }

  set(path: string, rec: FileRec | null): void {
    if (!this.cur.has(path)) this.get(path);
    this.cur.set(path, rec);
  }

  existedInitially(path: string): boolean {
    return (this.init.get(path) ?? null) !== null;
  }

  changed(): Change[] {
    const out: Change[] = [];
    for (const p of new Set([...this.init.keys(), ...this.cur.keys()])) {
      const a = this.init.get(p) ?? null;
      const b = this.cur.get(p) ?? null;
      if (a === null && b === null) continue;
      if (a === null) out.push({ path: p, kind: 'A', rec: b });
      else if (b === null) out.push({ path: p, kind: 'D', rec: null });
      else if (serializeText(a) !== serializeText(b)) out.push({ path: p, kind: 'M', rec: b });
    }
    return out;
  }

  writeChanges(changes: Change[]): void {
    for (const c of changes) {
      if (c.rec === null) {
        try { rmSync(c.path, { force: true }); } catch { /* already gone */ }
      } else {
        const d = dirname(c.path);
        if (d !== '.') mkdirSync(d, { recursive: true });
        writeFileSync(c.path, serializeText(c.rec));
      }
    }
  }
}

// ---------- unified diff (SPEC section 6) ----------

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function toNull(p: string): string | null {
  return p === '/dev/null' ? null : p;
}

// Path after '--- '/'+++ ': up to first tab, trimmed, one a//b/ prefix off.
function diffPath(raw: string): string | null {
  return toNull(stripAB(raw.split('\t')[0].trim()));
}

interface UniHunk {
  a: number;
  body: string[];
}

interface UniSection {
  oldRaw: string | null;
  newRaw: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UniHunk[];
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const flush = (): void => {
    if (cur !== null) { edits.push(makeUniEdit(cur)); cur = null; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new ParseFault(ln);
      flush();
      cur = { oldRaw: toNull(stripAB(m[1])), newRaw: toNull(stripAB(m[2])), isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new ParseFault(ln);
      if (cur === null) throw new ParseFault(ln);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) { body.push(b); i++; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: parseInt(m[1], 10), body });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
          cur.oldRaw = diffPath(line.slice(4));
          cur.newRaw = diffPath(lines[i + 1].slice(4));
          i += 2;
          continue;
        }
        throw new ParseFault(ln + 1);
      }
      if (line.startsWith('rename from ')) { cur.oldRaw = line.slice(12).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { cur.newRaw = line.slice(10).trim(); i++; continue; }
      if (line.startsWith('new file mode')) { cur.isCreate = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { cur.isDelete = true; i++; continue; }
      i++;
      continue;
    }

    if (cur === null) {
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        cur = { oldRaw: diffPath(line.slice(4)), newRaw: diffPath(lines[i + 1].slice(4)), isCreate: false, isDelete: false, hunks: [] };
        inHeader = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // After hunks: '--- ' + '+++ ' starts a new section; anything else is prose.
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      flush();
      cur = { oldRaw: diffPath(line.slice(4)), newRaw: diffPath(lines[i + 1].slice(4)), isCreate: false, isDelete: false, hunks: [] };
      inHeader = true;
      i += 2;
      continue;
    }
    i++;
  }
  flush();
  return edits;
}

// Split one hunk body into old/new specs + whether '\' follows the last
// context/'+' line (controls the result's final line break).
function hunkON(body: string[]): { o: NSpec[]; n: NSpec[]; backslash: boolean } {
  const o: NSpec[] = [];
  const n: NSpec[] = [];
  let lastCtxNew = -1;
  body.forEach((b, idx) => {
    if (b.startsWith(' ') || b === '') {
      const oi = o.length;
      const txt = b === '' ? '' : b.slice(1);
      o.push({ text: txt, ctx: true, oIdx: oi });
      n.push({ text: txt, ctx: true, oIdx: oi });
      lastCtxNew = idx;
    } else if (b.startsWith('-')) {
      o.push({ text: b.slice(1), ctx: false, oIdx: -1 });
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), ctx: false, oIdx: -1 });
      lastCtxNew = idx;
    }
  });
  let backslash = false;
  if (lastCtxNew >= 0 && body[lastCtxNew + 1] !== undefined && body[lastCtxNew + 1].startsWith('\\')) backslash = true;
  return { o, n, backslash };
}

function applyHunks(rec: FileRec, hunks: UniHunk[], strict: boolean): { ok: true; rec: FileRec } | { ok: false; code: string } {
  let lines = [...rec.lines];
  let ends = rec.ends;
  let d = 0;
  for (const h of hunks) {
    const { o, n, backslash } = hunkON(h.body);
    const oTexts = o.map((e) => e.text);
    if (o.length === 0) {
      const newLines = n.map((e) => e.text);
      const at = Math.min(h.a + d, lines.length);
      if (newLines.length > 0) {
        const atEnd = at === lines.length;
        lines = [...lines.slice(0, at), ...newLines, ...lines.slice(at)];
        if (atEnd) ends = !backslash;
      }
      d += newLines.length;
      continue;
    }
    const found = firstTierOcc(lines, oTexts, strict, 0);
    if (found === null) return { ok: false, code: 'no-match' };
    const target = h.a - 1 + d;
    let best = found.pos[0];
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const newLines = buildNewLines(lines, best, oTexts, n, found.tier);
    const reachesEnd = best + o.length === lines.length;
    lines = replaceAt(lines, best, o.length, newLines);
    if (reachesEnd) ends = lines.length === 0 ? false : !backslash;
    d += newLines.length - o.length;
  }
  return { ok: true, rec: { lines, brk: rec.brk, ends } };
}

// '+' lines of a creation, in order, with the final-break rule.
function collectPlusLines(hunks: UniHunk[]): FileRec {
  const out: string[] = [];
  let lastPlus: { h: number; idx: number } | null = null;
  hunks.forEach((h, hi) => {
    h.body.forEach((b, bi) => {
      if (b.startsWith('+')) { out.push(b.slice(1)); lastPlus = { h: hi, idx: bi }; }
    });
  });
  let ends = out.length > 0;
  if (lastPlus !== null) {
    const body = hunks[lastPlus.h].body;
    if (body[lastPlus.idx + 1] !== undefined && body[lastPlus.idx + 1].startsWith('\\')) ends = false;
  }
  return { lines: out, brk: '\n', ends };
}

function makeUniEdit(s: UniSection): Edit {
  return {
    apply: (t: Tree, strict: boolean): EditResult => {
      const oldP = s.oldRaw;
      const newP = s.newRaw;
      if (oldP !== null && !isSafe(oldP)) return fail('unsafe', oldP);
      if (newP !== null && !isSafe(newP)) return fail('unsafe', newP);
      const isCreate = oldP === null || s.isCreate;
      const isDelete = newP === null || s.isDelete;
      if (isCreate) {
        if (newP === null) return okEdit();
        if (t.get(newP) !== null) return fail('exists', newP);
        t.set(newP, collectPlusLines(s.hunks));
        return okEdit();
      }
      if (isDelete) {
        if (oldP === null) return okEdit();
        if (t.get(oldP) === null) return fail('missing', oldP);
        t.set(oldP, null);
        return okEdit();
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        const rec = t.get(oldP);
        if (rec === null) return fail('missing', oldP);
        if (t.get(newP) !== null) return fail('exists', newP);
        const r = applyHunks(rec, s.hunks, strict);
        if (!r.ok) return fail(r.code, oldP);
        t.set(newP, r.rec);
        t.set(oldP, null);
        return okEdit({ old: oldP, new: newP });
      }
      if (oldP === null) return okEdit();
      const rec = t.get(oldP);
      if (rec === null) return fail('missing', oldP);
      const r = applyHunks(rec, s.hunks, strict);
      if (!r.ok) return fail(r.code, oldP);
      t.set(oldP, r.rec);
      return okEdit();
    },
  };
}

// ---------- SEARCH/REPLACE (SPEC section 7) ----------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (rstrip(lines[i]) === '<<<<<<< SEARCH') {
      const searchLn = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new ParseFault(searchLn);
        path = prevPath;
      }
      const oldLines: string[] = [];
      i++;
      let foundEq = false;
      while (i < lines.length) {
        if (rstrip(lines[i]) === '=======') { foundEq = true; i++; break; }
        oldLines.push(lines[i]);
        i++;
      }
      if (!foundEq) throw new ParseFault(searchLn);
      const newLines: string[] = [];
      let foundRep = false;
      while (i < lines.length) {
        if (rstrip(lines[i]) === '>>>>>>> REPLACE') { foundRep = true; i++; break; }
        newLines.push(lines[i]);
        i++;
      }
      if (!foundRep) throw new ParseFault(searchLn);
      edits.push(makeSREdit(path, oldLines, newLines));
      prevPath = path;
      prevEnd = i;
      continue;
    }
    i++;
  }
  return edits;
}

function makeSREdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return {
    apply: (t: Tree, strict: boolean): EditResult => {
      if (!isSafe(path)) return fail('unsafe', path);
      if (oldLines.length === 0) {
        if (t.get(path) !== null) return fail('exists', path);
        t.set(path, { lines: [...newLines], brk: '\n', ends: newLines.length > 0 });
        return okEdit();
      }
      const rec = t.get(path);
      if (rec === null) return fail('missing', path);
      const found = firstTierOcc(rec.lines, oldLines, strict, 0);
      if (found === null) return fail('no-match', path);
      if (found.pos.length > 1) return fail('ambiguous', path);
      const pos = found.pos[0];
      const nspec: NSpec[] = newLines.map((text) => ({ text, ctx: false, oIdx: -1 }));
      const built = buildNewLines(rec.lines, pos, oldLines, nspec, found.tier);
      t.set(path, { lines: replaceAt(rec.lines, pos, oldLines.length, built), brk: rec.brk, ends: rec.ends });
      return okEdit();
    },
  };
}

// ---------- V4A (SPEC section 8) ----------

const SECTION_RE = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

function isV4ABodyLine(s: string): boolean {
  return s === '' || s.startsWith(' ') || s.startsWith('-') || s.startsWith('+');
}

function bodyToON(body: { text: string; ln: number }[]): { o: NSpec[]; n: NSpec[] } {
  const o: NSpec[] = [];
  const n: NSpec[] = [];
  for (const r of body) {
    const b = r.text;
    if (b.startsWith(' ') || b === '') {
      const oi = o.length;
      o.push({ text: b === '' ? '' : b.slice(1), ctx: true, oIdx: oi });
      n.push({ text: b === '' ? '' : b.slice(1), ctx: true, oIdx: oi });
    } else if (b.startsWith('-')) {
      o.push({ text: b.slice(1), ctx: false, oIdx: -1 });
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

interface V4AChunk {
  anchor: string | null;
  o: NSpec[];
  n: NSpec[];
  endOfFile: boolean;
}

function parseV4AChunks(raw: { text: string; ln: number }[], updateLn: number, moveTo: string | null): V4AChunk[] {
  const chunks: V4AChunk[] = [];
  let cur: { anchor: string | null; body: { text: string; ln: number }[]; endOfFile: boolean } | null = null;
  const push = (): void => {
    if (cur === null) return;
    const { o, n } = bodyToON(cur.body);
    chunks.push({ anchor: cur.anchor, o, n, endOfFile: cur.endOfFile });
    cur = null;
  };
  for (const r of raw) {
    if (r.text.startsWith('@@')) {
      push();
      cur = { anchor: r.text.slice(2).trim() || null, body: [], endOfFile: false };
      continue;
    }
    if (rstrip(r.text) === '*** End of File') {
      if (cur === null) throw new ParseFault(r.ln);
      cur.endOfFile = true;
      push();
      continue;
    }
    if (cur === null) {
      if (chunks.length > 0) throw new ParseFault(r.ln);
      if (!isV4ABodyLine(r.text)) throw new ParseFault(r.ln);
      cur = { anchor: null, body: [], endOfFile: false };
      cur.body.push(r);
      continue;
    }
    if (!isV4ABodyLine(r.text)) throw new ParseFault(r.ln);
    cur.body.push(r);
  }
  push();
  if (chunks.length === 0 && moveTo === null) throw new ParseFault(updateLn);
  return chunks;
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() !== '') { first = k; break; }
  }
  if (first === -1) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k].trim() !== '') { last = k; break; }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    const ln = i + 1;
    if (line.trim() === '') { i++; continue; }
    const m = SECTION_RE.exec(line);
    if (m === null) throw new ParseFault(ln);
    const kind = m[1];
    const path = m[2].trim();
    i++;
    if (kind === 'Add File') {
      const raw: { text: string; ln: number }[] = [];
      while (i < last) {
        const l = lines[i];
        if (SECTION_RE.test(l)) break;
        if (l.trim() === '*** End Patch') break;
        raw.push({ text: l, ln: i + 1 });
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new ParseFault(r.ln);
      }
      edits.push(makeV4AAdd(path, fileLines));
      continue;
    }
    if (kind === 'Delete File') {
      while (i < last) {
        const l = lines[i];
        if (SECTION_RE.test(l)) break;
        if (l.trim() === '*** End Patch') break;
        if (l.trim() !== '') throw new ParseFault(i + 1);
        i++;
      }
      edits.push(makeV4ADelete(path));
      continue;
    }
    const updateLn = ln;
    let moveTo: string | null = null;
    if (i < last && lines[i].startsWith('*** Move to: ')) {
      moveTo = lines[i].slice('*** Move to: '.length).trim();
      i++;
    }
    const raw: { text: string; ln: number }[] = [];
    while (i < last) {
      const l = lines[i];
      if (SECTION_RE.test(l)) break;
      if (l.trim() === '*** End Patch') break;
      raw.push({ text: l, ln: i + 1 });
      i++;
    }
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
    edits.push(makeV4AUpdate(path, moveTo, parseV4AChunks(raw, updateLn, moveTo)));
  }
  return edits;
}

function makeV4AAdd(path: string, fileLines: string[]): Edit {
  return {
    apply: (t: Tree): EditResult => {
      if (!isSafe(path)) return fail('unsafe', path);
      if (t.get(path) !== null) return fail('exists', path);
      t.set(path, { lines: [...fileLines], brk: '\n', ends: fileLines.length > 0 });
      return okEdit();
    },
  };
}

function makeV4ADelete(path: string): Edit {
  return {
    apply: (t: Tree): EditResult => {
      if (!isSafe(path)) return fail('unsafe', path);
      if (t.get(path) === null) return fail('missing', path);
      t.set(path, null);
      return okEdit();
    },
  };
}

function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (tierEq(lines[i], anchor, tier)) return i;
    }
  }
  return null;
}

function makeV4AUpdate(path: string, moveTo: string | null, chunks: V4AChunk[]): Edit {
  return {
    apply: (t: Tree, strict: boolean): EditResult => {
      if (!isSafe(path)) return fail('unsafe', path);
      if (moveTo !== null && !isSafe(moveTo)) return fail('unsafe', moveTo);
      const rec = t.get(path);
      if (rec === null) return fail('missing', path);
      if (moveTo !== null && t.get(moveTo) !== null) return fail('exists', moveTo);
      let lines = [...rec.lines];
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const aIdx = findAnchor(lines, ch.anchor, strict, cursor);
          if (aIdx === null) return fail('no-match', path);
          cursor = aIdx + 1;
        }
        const oTexts = ch.o.map((e) => e.text);
        if (oTexts.length === 0) {
          const at = ch.endOfFile ? lines.length : cursor;
          const built = ch.n.map((e) => e.text);
          lines = [...lines.slice(0, at), ...built, ...lines.slice(at)];
          cursor = at + built.length;
          continue;
        }
        const found = firstTierOcc(lines, oTexts, strict, cursor, ch.endOfFile);
        if (found === null) return fail('no-match', path);
        const pos = found.pos[0];
        const built = buildNewLines(lines, pos, oTexts, ch.n, found.tier);
        lines = replaceAt(lines, pos, oTexts.length, built);
        cursor = pos + built.length;
      }
      const out: FileRec = { lines, brk: rec.brk, ends: rec.ends };
      if (moveTo !== null) {
        t.set(moveTo, out);
        t.set(path, null);
        return okEdit({ old: path, new: moveTo });
      }
      t.set(path, out);
      return okEdit();
    },
  };
}

// ---------- JSON (SPEC section 9) ----------

function parseJson(lines: string[]): Edit[] {
  const nonBlank = lines.map((l, idx) => ({ l, idx })).filter((x) => x.l.trim() !== '');
  if (nonBlank.length === 0) throw new ParseFault(1);
  const first = nonBlank[0];
  if (first.l.trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(lines.slice(first.idx).join('\n'));
    } catch {
      throw new ParseFault(first.idx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseFault(first.idx + 1);
    return arr.map((el) => jsonEdit(el, first.idx + 1));
  }
  const edits: Edit[] = [];
  for (const { l, idx } of nonBlank) {
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseFault(idx + 1);
    }
    edits.push(jsonEdit(obj, idx + 1));
  }
  return edits;
}

function jsonEdit(obj: unknown, lineNo: number): Edit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new ParseFault(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseFault(lineNo);
  if (typeof o.command !== 'string') throw new ParseFault(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseFault(lineNo);
    return makeJsonCreate(o.path, o.file_text);
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseFault(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseFault(lineNo);
    return makeJsonStrReplace(o.path, o.old_str, (o.new_str as string | undefined) ?? '');
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseFault(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseFault(lineNo);
    return makeJsonInsert(o.path, o.insert_line, o.new_str);
  }
  throw new ParseFault(lineNo);
}

function makeJsonCreate(path: string, fileText: string): Edit {
  return {
    apply: (t: Tree): EditResult => {
      if (!isSafe(path)) return fail('unsafe', path);
      if (t.get(path) !== null) return fail('exists', path);
      t.set(path, parseText(fileText));
      return okEdit();
    },
  };
}

function makeJsonStrReplace(path: string, oldStr: string, newStr: string): Edit {
  return {
    apply: (t: Tree): EditResult => {
      if (!isSafe(path)) return fail('unsafe', path);
      const rec = t.get(path);
      if (rec === null) return fail('missing', path);
      const text = serializeText(rec);
      let hay = text;
      let oldS = oldStr;
      let newS = newStr;
      if (rec.brk === '\r\n') {
        hay = text.replace(/\r\n/g, '\n');
        oldS = oldStr.replace(/\r\n/g, '\n');
        newS = newStr.replace(/\r\n/g, '\n');
      }
      let count = 0;
      let firstAt = -1;
      let at = hay.indexOf(oldS);
      while (at !== -1) {
        if (count === 0) firstAt = at;
        count++;
        at = hay.indexOf(oldS, at + 1);
      }
      if (count === 0) return fail('no-match', path);
      if (count > 1) return fail('ambiguous', path);
      let result = hay.slice(0, firstAt) + newS + hay.slice(firstAt + oldS.length);
      if (rec.brk === '\r\n') result = result.replace(/\n/g, '\r\n');
      t.set(path, parseText(result));
      return okEdit();
    },
  };
}

function makeJsonInsert(path: string, insertLine: number, newStr: string): Edit {
  return {
    apply: (t: Tree): EditResult => {
      if (!isSafe(path)) return fail('unsafe', path);
      const rec = t.get(path);
      if (rec === null) return fail('missing', path);
      if (insertLine < 0 || insertLine > rec.lines.length) return fail('no-match', path);
      const ins = splitPatchLines(newStr);
      const lines = [...rec.lines.slice(0, insertLine), ...ins, ...rec.lines.slice(insertLine)];
      t.set(path, { lines, brk: rec.brk, ends: rec.ends });
      return okEdit();
    },
  };
}

// ---------- format detection (SPEC section 4) + CLI (SPEC section 1) ----------

function detectFormat(lines: string[]): string | null {
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx === -1) return null;
  const first = lines[firstIdx].trim();
  if (first === '*** Begin Patch') return 'v4a';
  const c = first[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (rstrip(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startsWith('diff --git ')) return 'unified';
    if (lines[k].startsWith('--- ') && k + 1 < lines.length && lines[k + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(args: string[]): CliArgs | 'usage' {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let positional: string | null = null;
  let endOpts = false;
  let seenCheck = false;
  let seenStrict = false;
  let seenFormat = false;
  for (const a of args) {
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return 'usage';
        seenCheck = true;
        check = true;
        continue;
      }
      if (a === '--strict') {
        if (seenStrict) return 'usage';
        seenStrict = true;
        strict = true;
        continue;
      }
      if (a.startsWith('--format=')) {
        if (seenFormat) return 'usage';
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return 'usage';
        format = v;
        continue;
      }
      return 'usage';
    }
    if (positional !== null) return 'usage';
    positional = a;
  }
  return { format: format ?? 'auto', check, strict, patch: positional };
}

function parsePatch(format: string, lines: string[]): Edit[] {
  if (format === 'unified') return parseUnified(lines);
  if (format === 'search-replace') return parseSearchReplace(lines);
  if (format === 'v4a') return parseV4A(lines);
  return parseJson(lines);
}

// ---------- main entry (SPEC sections 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  const parsed = parseArgs(args);
  if (parsed === 'usage') return { code: 2, out: ['error: usage'] };
  let patchText: string;
  if (parsed.patch === null || parsed.patch === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      patchText = '';
    }
  } else {
    try {
      patchText = readFileSync(parsed.patch, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = splitPatchLines(patchText);
  let format = parsed.format;
  if (format === 'auto') {
    const d = detectFormat(lines);
    if (d === null) return { code: 2, out: ['error: format'] };
    format = d;
  }
  let edits: Edit[];
  try {
    edits = parsePatch(format, lines);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const errors: { code: string; path: string }[] = [];
  const moves: { old: string; new: string }[] = [];
  for (const ed of edits) {
    const r = ed.apply(tree, parsed.strict);
    if (!r.ok) errors.push({ code: r.code, path: r.path });
    else if (r.move !== undefined) moves.push(r.move);
  }
  if (errors.length > 0) {
    const out = errors.map((e) => `error: ${e.code} ${e.path}`);
    out.push(`failed: ${errors.length} of ${edits.length} edits`);
    return { code: 1, out };
  }

  const changes = tree.changed();
  const eff: { old: string; new: string }[] = [];
  for (const m of moves) {
    const prev = eff.find((e) => e.new === m.old);
    if (prev !== undefined) prev.new = m.new;
    else eff.push({ old: m.old, new: m.new });
  }
  const byPath = new Map<string, Change>();
  for (const c of changes) byPath.set(c.path, c);
  interface Disp { key: string; text: string; }
  const disp: Disp[] = [];
  for (const m of eff) {
    const dOld = byPath.get(m.old);
    const aNew = byPath.get(m.new);
    if (dOld !== undefined && dOld.kind === 'D' && aNew !== undefined && aNew.kind === 'A') {
      byPath.delete(m.old);
      byPath.delete(m.new);
      disp.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
    } else if (aNew !== undefined && aNew.kind === 'A' && !byPath.has(m.old) && !tree.existedInitially(m.old)) {
      byPath.delete(m.new);
      disp.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  for (const [p, c] of byPath) {
    if (c.kind === 'A') disp.push({ key: p, text: `A ${p}` });
    else if (c.kind === 'D') disp.push({ key: p, text: `D ${p}` });
    else disp.push({ key: p, text: `M ${p}` });
  }
  disp.sort((a, b) => byteCmp(a.key, b.key));
  if (!parsed.check) tree.writeChanges(changes);
  const n = disp.length;
  const out = disp.map((d) => d.text);
  out.push(n === 1 ? 'ok: 1 file' : `ok: ${n} files`);
  return { code: 0, out };
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
