/**
 * Interface/class parsing helpers for interface-implementation-consistency.
 */

import {
  ASYNC_STATIC_METHOD_PATTERN,
  CLASS_LEVEL_METHOD_PATTERN,
  CLASS_PATTERN,
  INTERFACE_EXTENDS_CONTINUATION,
  INTERFACE_PATTERN,
  isJsKeyword,
  METHOD_BODY_PATTERN,
  METHOD_IN_CLASS_PATTERN,
  METHOD_IN_INTERFACE_PATTERN,
  STATIC_MODIFIER_PATTERN,
  TYPE_ANNOTATION_PATTERN,
  VISIBILITY_MODIFIER_PATTERN,
} from './interface-implementation-consistency-constants.js';

export interface InterfaceDefinition {
  name: string;
  methods: string[];
  extends: string[];
  startLine: number;
  file: string;
}

export interface ClassImplementation {
  name: string;
  implements: string[];
  methods: string[];
  startLine: number;
  file: string;
}

export function stripGenerics(typeRef: string): string {
  let prev = typeRef;
  for (;;) {
    const next = prev.replaceAll(/<[^<>]*>/g, '');
    if (next === prev) return next.trim();
    prev = next;
  }
}

function countBraces(line: string): { open: number; close: number } {
  let open = 0;
  let close = 0;
  for (const char of line) {
    if (char === '{') open++;
    if (char === '}') close++;
  }
  return { open, close };
}

interface ParseState {
  name: string;
  extends: string[];
  startLine: number;
  methods: string[];
  braces: number;
}

function splitTopLevel(raw: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of raw) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      segments.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) segments.push(buf);
  return segments;
}

function parseTypeList(raw: string): string[] {
  return splitTopLevel(raw)
    .map((segment) => stripGenerics(segment.trim()))
    .filter(Boolean);
}

function tryStartInterface(line: string, lineIndex: number): ParseState | null {
  const match = INTERFACE_PATTERN.exec(line);
  if (!match?.[1]) return null;
  return {
    name: match[1],
    extends: parseTypeList(match[2] ?? ''),
    startLine: lineIndex + 1,
    methods: [],
    braces: 0,
  };
}

function extractInterfaceMethod(line: string): string | null {
  const methodMatch = METHOD_IN_INTERFACE_PATTERN.exec(line);
  if (!methodMatch?.[1]) return null;
  /* v8 ignore next 2 */
  if (isJsKeyword(methodMatch[1])) return null;
  if (line.includes('//')) return null;
  return methodMatch[1];
}

export function parseInterfaces(content: string, file: string): InterfaceDefinition[] {
  const interfaces: InterfaceDefinition[] = [];
  const lines = content.split('\n');
  let current: ParseState | null = null;

  for (const [i, line_] of lines.entries()) {
    /* v8 ignore next */
    const line = line_ ?? '';

    const justStarted = current === null;
    current ??= tryStartInterface(line, i);
    if (!current) continue;

    if (!justStarted && current.braces === 0 && current.extends.length === 0) {
      const continuationMatch = INTERFACE_EXTENDS_CONTINUATION.exec(line);
      if (continuationMatch?.[1]) {
        current.extends = parseTypeList(continuationMatch[1]);
      }
    }

    const hadBraces = current.braces > 0;
    const { open, close } = countBraces(line);
    current.braces += open - close;

    const method = extractInterfaceMethod(line);
    if (method) {
      current.methods.push(method);
    }

    if (current.braces === 0 && (hadBraces || open > 0)) {
      interfaces.push({
        name: current.name,
        extends: current.extends,
        methods: current.methods,
        startLine: current.startLine,
        file,
      });
      current = null;
    }
  }

  return interfaces;
}

/* v8 ignore start */
function isMethodDefinition(line: string): boolean {
  const trimmed = line.trim();
  const leadingWhitespace = line.length - line.trimStart().length;

  if (leadingWhitespace > 4) return false;
  if (trimmed.endsWith(');')) return false;
  if (trimmed.endsWith('),') || trimmed.endsWith('(,')) return false;
  if (VISIBILITY_MODIFIER_PATTERN.test(trimmed)) return true;
  if (ASYNC_STATIC_METHOD_PATTERN.test(trimmed)) return true;
  if (TYPE_ANNOTATION_PATTERN.test(trimmed) || METHOD_BODY_PATTERN.test(trimmed)) return true;
  if (leadingWhitespace <= 2 && CLASS_LEVEL_METHOD_PATTERN.test(trimmed)) return true;

  return false;
}
/* v8 ignore stop */

interface ClassParseState {
  name: string;
  implements: string[];
  startLine: number;
  methods: string[];
  braces: number;
}

function tryStartClass(line: string, lineIndex: number): ClassParseState | null {
  const match = CLASS_PATTERN.exec(line);
  if (!match?.[1]) return null;
  return {
    name: match[1],
    /* v8 ignore next */
    implements: parseTypeList(match[2] ?? ''),
    startLine: lineIndex + 1,
    methods: [],
    braces: 0,
  };
}

/* v8 ignore start */
function extractClassMethod(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('private') || trimmed.startsWith('protected')) return null;
  if (line.includes('//')) return null;
  if (STATIC_MODIFIER_PATTERN.test(line)) return null;

  const methodMatch = METHOD_IN_CLASS_PATTERN.exec(line);
  if (!methodMatch?.[1]) return null;
  if (methodMatch[1] === 'constructor') return null;
  if (isJsKeyword(methodMatch[1])) return null;
  if (!isMethodDefinition(line)) return null;

  return methodMatch[1];
}
/* v8 ignore stop */

export function parseClasses(content: string, file: string): ClassImplementation[] {
  const classes: ClassImplementation[] = [];
  const lines = content.split('\n');
  let current: ClassParseState | null = null;

  for (const [i, line_] of lines.entries()) {
    /* v8 ignore next */
    const line = line_ ?? '';

    current ??= tryStartClass(line, i);
    if (!current) continue;

    const hadBraces = current.braces > 0;
    const { open, close } = countBraces(line);
    current.braces += open - close;

    const method = extractClassMethod(line);
    if (method) {
      current.methods.push(method);
    }

    if (current.braces === 0 && (hadBraces || open > 0)) {
      classes.push({
        name: current.name,
        implements: current.implements,
        methods: [...new Set(current.methods)],
        startLine: current.startLine,
        file,
      });
      current = null;
    }
  }

  return classes;
}

export function mergeInterface(
  allInterfaces: Map<string, InterfaceDefinition>,
  iface: InterfaceDefinition,
): void {
  const existing = allInterfaces.get(iface.name);
  if (!existing) {
    allInterfaces.set(iface.name, iface);
    return;
  }
  const methodSet = new Set(existing.methods);
  for (const method of iface.methods) methodSet.add(method);
  allInterfaces.set(iface.name, { ...existing, methods: [...methodSet] });
}

/* v8 ignore start */
function resolveInterface(
  allInterfaces: Map<string, InterfaceDefinition>,
  name: string,
): InterfaceDefinition | undefined {
  const bare = stripGenerics(name);
  let iface = allInterfaces.get(bare);
  if (iface) return iface;

  if (bare.startsWith('I') && bare.length > 1 && bare[1] === bare[1]?.toUpperCase()) {
    iface = allInterfaces.get(bare.slice(1));
    if (iface) return iface;
  }

  return allInterfaces.get('I' + bare);
}
/* v8 ignore stop */

export function createInterfaceMethodsResolver(
  allInterfaces: Map<string, InterfaceDefinition>,
): (name: string, visited?: Set<string>) => string[] {
  return function getInterfaceMethods(name: string, visited = new Set<string>()): string[] {
    if (visited.has(name)) return [];
    visited.add(name);

    const iface = resolveInterface(allInterfaces, name);
    if (!iface) return [];

    const methods = [...iface.methods];
    for (const ext of iface.extends) {
      for (const method of getInterfaceMethods(ext, visited)) methods.push(method);
    }
    return methods;
  };
}
