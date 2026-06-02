import type { Frontmatter, FrontmatterValue } from "./types";

export interface ParsedFile {
  readonly frontmatter: Frontmatter;
  readonly body: string;
}

const FRONTMATTER_OPEN = /^---\s*\r?\n/;
const FRONTMATTER_CLOSE = /\r?\n---\s*(\r?\n|$)/;

export const parseFile = (source: string): ParsedFile => {
  const trimmed = source.startsWith("﻿") ? source.slice(1) : source;
  if (!FRONTMATTER_OPEN.test(trimmed)) {
    return { frontmatter: {}, body: trimmed };
  }
  const afterOpen = trimmed.replace(FRONTMATTER_OPEN, "");
  const closeMatch = afterOpen.match(FRONTMATTER_CLOSE);
  if (!closeMatch || closeMatch.index === undefined) {
    return { frontmatter: {}, body: trimmed };
  }
  const yaml = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return { frontmatter: parseYamlFrontmatter(yaml), body };
};

export const serializeFile = (frontmatter: Frontmatter, body: string): string => {
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return body;
  const lines: string[] = ["---"];
  for (const key of keys) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    appendYamlEntry(lines, key, value);
  }
  lines.push("---", "");
  return `${lines.join("\n")}${body}`;
};

const parseYamlFrontmatter = (yaml: string): Frontmatter => {
  const out: Record<string, FrontmatterValue> = {};
  const rawLines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i] ?? "";
    i += 1;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = leadingSpaces(line);
    if (indent !== 0) continue;
    const colon = findUnquotedColon(line);
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (key === "") continue;
    const after = line.slice(colon + 1).trimEnd();
    const inline = after.replace(/^\s+/, "");
    if (inline === "" || inline === "|" || inline === ">") {
      const collected = collectChildren(rawLines, i);
      i = collected.nextIndex;
      out[key] = parseChildren(collected.children, inline === "|" || inline === ">");
      continue;
    }
    out[key] = parseScalar(inline);
  }
  return out;
};

const leadingSpaces = (s: string): number => {
  let n = 0;
  while (n < s.length && s.charCodeAt(n) === 32) n += 1;
  return n;
};

const findUnquotedColon = (line: string): number => {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ":" && !inSingle && !inDouble) return i;
  }
  return -1;
};

interface ChildBlock {
  readonly children: readonly string[];
  readonly nextIndex: number;
}

const collectChildren = (lines: readonly string[], startIndex: number): ChildBlock => {
  const children: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      children.push("");
      i += 1;
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent === 0) break;
    children.push(line);
    i += 1;
  }
  return { children, nextIndex: i };
};

const parseChildren = (lines: readonly string[], blockScalar: boolean): FrontmatterValue => {
  if (blockScalar) {
    const minIndent = lines
      .filter((l) => l.trim() !== "")
      .reduce((min, l) => Math.min(min, leadingSpaces(l)), Number.POSITIVE_INFINITY);
    const indent = Number.isFinite(minIndent) ? minIndent : 0;
    return lines.map((l) => l.slice(indent)).join("\n").trimEnd();
  }
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length === 0) return "";
  const allList = nonEmpty.every((l) => /^\s*-\s+/.test(l));
  if (allList) {
    return nonEmpty.map((l) => parseScalarString(l.replace(/^\s*-\s+/, "")));
  }
  const map: Record<string, string> = {};
  for (const l of nonEmpty) {
    const colon = findUnquotedColon(l);
    if (colon < 0) continue;
    const k = l.slice(0, colon).trim();
    const v = l.slice(colon + 1).trim();
    if (k !== "") map[k] = parseScalarString(v);
  }
  return map;
};

const parseScalar = (raw: string): FrontmatterValue => {
  const v = raw.trim();
  if (v === "") return "";
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowList(inner).map(parseScalarString);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return parseScalarString(v);
};

const parseScalarString = (raw: string): string => {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
};

const splitFlowList = (s: string): readonly string[] => {
  const out: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === "[" || c === "{") depth += 1;
      else if (c === "]" || c === "}") depth -= 1;
      else if (c === "," && depth === 0) {
        out.push(s.slice(start, i));
        start = i + 1;
      }
    }
  }
  out.push(s.slice(start));
  return out.map((p) => p.trim()).filter((p) => p !== "");
};

const appendYamlEntry = (lines: string[], key: string, value: FrontmatterValue): void => {
  if (value === null) {
    lines.push(`${key}: null`);
    return;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    lines.push(`${key}: ${String(value)}`);
    return;
  }
  if (typeof value === "string") {
    if (value === "") {
      lines.push(`${key}: ""`);
      return;
    }
    if (value.includes("\n")) {
      lines.push(`${key}: |`);
      for (const part of value.split("\n")) lines.push(`  ${part}`);
      return;
    }
    lines.push(`${key}: ${quoteIfNeeded(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${key}: []`);
      return;
    }
    lines.push(`${key}:`);
    for (const item of value) lines.push(`  - ${quoteIfNeeded(item)}`);
    return;
  }
  const obj = value as Readonly<Record<string, string>>;
  const objKeys = Object.keys(obj);
  if (objKeys.length === 0) {
    lines.push(`${key}: {}`);
    return;
  }
  lines.push(`${key}:`);
  for (const k of objKeys) lines.push(`  ${k}: ${quoteIfNeeded(obj[k] ?? "")}`);
};

const NEEDS_QUOTE = /[:#&*!|>'"%@`,\[\]{}]|^\s|\s$|^-?\d|^(true|false|null|yes|no|on|off)$/i;

const quoteIfNeeded = (s: string): string => {
  if (s === "") return '""';
  if (NEEDS_QUOTE.test(s)) {
    const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return s;
};
