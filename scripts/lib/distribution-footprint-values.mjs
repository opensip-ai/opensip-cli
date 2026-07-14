import { isAbsolute, relative, sep } from 'node:path';

import { DISTRIBUTION_MAX_STRING_LENGTH } from './distribution-footprint-constants.mjs';

export function requireRecord(value, source) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${source} must be an object`);
  }
  return value;
}

export function requiredString(value, source) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${source} must be a non-empty string`);
  }
  return value;
}

export function boundedIdentity(value, source) {
  const identity = requiredString(value, source);
  if (identity.length > DISTRIBUTION_MAX_STRING_LENGTH || containsControlCharacter(identity)) {
    throw new Error(`${source} contains an invalid or overlong identity`);
  }
  return identity;
}

export function nonnegativeFiniteNumber(value, source) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${source} must be a finite non-negative number`);
  }
  return value;
}

export function positiveSafeInteger(value, source) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${source} must be a positive safe integer`);
  }
  return value;
}

export function nonnegativeSafeInteger(value, source) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${source} must be a non-negative safe integer`);
  }
  return value;
}

export function addSafeIntegers(left, right, source) {
  nonnegativeSafeInteger(left, source);
  nonnegativeSafeInteger(right, source);
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${source} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return result;
}

export function sumSafeIntegers(values, source) {
  let result = 0;
  for (const value of values) result = addSafeIntegers(result, value, source);
  return result;
}

export function optionalSha256(value, source) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${source} must be a lowercase SHA-256 hex string`);
  }
  return value;
}

export function isoTimestamp(value, source) {
  const timestamp = requiredString(value, source);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) {
    throw new TypeError(`${source} must be a canonical ISO timestamp`);
  }
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new TypeError(`${source} must be a valid canonical ISO timestamp`);
  }
  return timestamp;
}

export function codePointCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isPathInside(root, candidate) {
  const child = relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
