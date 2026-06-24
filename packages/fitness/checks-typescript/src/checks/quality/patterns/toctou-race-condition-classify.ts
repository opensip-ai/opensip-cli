/**
 * Call-site classification for the TOCTOU race-condition check.
 */

import * as ts from 'typescript';

import {
  getReceiverChainText,
  isFunctionLikeNode,
  isInMemoryCacheReceiverText,
  type FunctionLikeNode,
} from './toctou-race-condition-collection.js';
import {
  isDrizzleAtomicWriteMethod,
  isReadMethod,
  isUpdateMethod,
  KIND_READ_LOCAL,
  KIND_READ_SHARED,
  KIND_UPDATE_LOCAL,
  KIND_UPDATE_SHARED,
} from './toctou-race-condition-constants.js';

/** Classification of a `<receiver>.<method>(...)` call site. */
export type CallKind =
  | { kind: typeof KIND_READ_SHARED }
  | { kind: typeof KIND_UPDATE_SHARED }
  | { kind: typeof KIND_READ_LOCAL }
  | { kind: typeof KIND_UPDATE_LOCAL }
  | { kind: 'atomic-sql-write' }
  | { kind: 'unrelated' };

function isAtomicSqlExecute(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  if (call.expression.name.text !== 'execute') return false;
  const arg = call.arguments[0];
  if (!arg) return false;
  if (ts.isTaggedTemplateExpression(arg) && ts.isIdentifier(arg.tag) && arg.tag.text === 'sql')
    return true;
  return false;
}

function isDrizzleAtomicWrite(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const methodName = call.expression.name.text;
  if (!isDrizzleAtomicWriteMethod(methodName)) return false;
  const receiver = call.expression.expression;
  if (ts.isIdentifier(receiver)) {
    const r = receiver.text;
    if (r === 'db' || r === 'tx' || /Db$|Tx$/.test(r)) return true;
  }
  return false;
}

function getReceiverName(call: ts.CallExpression): { name: string; isThisField: boolean } | null {
  if (!ts.isPropertyAccessExpression(call.expression)) return null;
  const receiver = call.expression.expression;
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
    return { name: call.expression.name.text, isThisField: true };
  }
  const chain = getReceiverChainText(receiver);
  if (!chain) return null;
  if (chain.startsWith('this.')) {
    return { name: chain.slice('this.'.length), isThisField: true };
  }
  return { name: chain, isThisField: false };
}

function isLocalReceiver(
  receiver: { name: string; isThisField: boolean },
  ctx: {
    localCollections: Set<string>;
    classCacheFields: Set<string>;
    localObjectCollectionKeys: Set<string>;
  },
): boolean {
  if (receiver.isThisField) {
    return ctx.classCacheFields.has(receiver.name) || isInMemoryCacheReceiverText(receiver.name);
  }
  return (
    ctx.localCollections.has(receiver.name) ||
    ctx.localObjectCollectionKeys.has(receiver.name) ||
    isInMemoryCacheReceiverText(receiver.name)
  );
}

function classifyCall(
  call: ts.CallExpression,
  ctx: {
    localCollections: Set<string>;
    classCacheFields: Set<string>;
    localObjectCollectionKeys: Set<string>;
  },
): CallKind {
  if (isAtomicSqlExecute(call)) return { kind: 'atomic-sql-write' };
  if (isDrizzleAtomicWrite(call)) return { kind: 'atomic-sql-write' };

  if (!ts.isPropertyAccessExpression(call.expression)) return { kind: 'unrelated' };
  const methodName = call.expression.name.text;
  const isRead = isReadMethod(methodName);
  const isUpdate = isUpdateMethod(methodName);
  if (!isRead && !isUpdate) return { kind: 'unrelated' };

  const receiver = getReceiverName(call);
  if (!receiver) {
    return { kind: isRead ? KIND_READ_SHARED : KIND_UPDATE_SHARED };
  }

  if (isLocalReceiver(receiver, ctx)) {
    return { kind: isRead ? KIND_READ_LOCAL : KIND_UPDATE_LOCAL };
  }
  return { kind: isRead ? KIND_READ_SHARED : KIND_UPDATE_SHARED };
}

/* eslint-disable sonarjs/cognitive-complexity -- TOCTOU classifier AST visitor */
export function classifyFunctionCalls(
  node: FunctionLikeNode,
  localCollections: Set<string>,
  classCacheFields: Set<string>,
  localObjectCollectionKeys: Set<string>,
): { hasSharedReadAndUpdateOnSameReceiver: boolean } {
  const ctx = { localCollections, classCacheFields, localObjectCollectionKeys };
  const perReceiver = new Map<string, { read: boolean; update: boolean }>();
  let hasReadOnUnknownReceiver = false;
  let hasUpdateOnUnknownReceiver = false;

  const visit = (n: ts.Node): void => {
    if (n !== node && isFunctionLikeNode(n)) return;
    if (ts.isCallExpression(n)) {
      const cls = classifyCall(n, ctx);
      if (cls.kind === 'read-shared' || cls.kind === 'update-shared') {
        const recv = getReceiverName(n);
        if (recv) {
          const key = recv.isThisField ? `this.${recv.name}` : recv.name;
          let entry = perReceiver.get(key);
          if (!entry) {
            entry = { read: false, update: false };
            perReceiver.set(key, entry);
          }
          if (cls.kind === 'read-shared') entry.read = true;
          else entry.update = true;
        } else {
          if (cls.kind === 'read-shared') hasReadOnUnknownReceiver = true;
          else hasUpdateOnUnknownReceiver = true;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  if (node.body) visit(node.body);

  for (const entry of perReceiver.values()) {
    if (entry.read && entry.update) {
      return { hasSharedReadAndUpdateOnSameReceiver: true };
    }
  }
  if (hasReadOnUnknownReceiver && hasUpdateOnUnknownReceiver) {
    return { hasSharedReadAndUpdateOnSameReceiver: true };
  }
  return { hasSharedReadAndUpdateOnSameReceiver: false };
}
/* eslint-enable sonarjs/cognitive-complexity */
