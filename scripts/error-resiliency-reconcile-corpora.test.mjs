/**
 * @fileoverview Plan 01 Task A.5 — tests for the corpus reconciliation.
 *
 * The reconciliation's contract is TOTALITY: every actionable site leaves with exactly
 * one terminal disposition, and `unknown` is not one of them. These tests pin that, plus
 * the matcher precedence that decides which recorded class a site belongs to.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifySite, reconcile } from './error-resiliency-reconcile-corpora.mjs';

const CLASSES = [
  { id: 'by-source', match: { sources: ['human'] } },
  { id: 'by-kind', match: { kinds: ['catch'] } },
  { id: 'by-family', match: { families: ['filesystem-datastore'] } },
];

const site = (over = {}) => ({
  siteKey: 'k',
  path: 'a.ts',
  kind: 'throw',
  source: 'structural',
  boundaryFamily: 'other',
  bucket: 'missed',
  ...over,
});

test('source matches before kind and family', () => {
  const s = site({ source: 'human', kind: 'catch', boundaryFamily: 'filesystem-datastore' });
  assert.equal(classifySite(s, CLASSES), 'by-source');
});

test('kind matches before family', () => {
  assert.equal(
    classifySite(site({ kind: 'catch', boundaryFamily: 'filesystem-datastore' }), CLASSES),
    'by-kind',
  );
});

test('family matches when neither source nor kind does', () => {
  assert.equal(
    classifySite(site({ boundaryFamily: 'filesystem-datastore' }), CLASSES),
    'by-family',
  );
});

test('a site matching no class is unassigned, never silently bucketed', () => {
  assert.equal(classifySite(site(), CLASSES), undefined);
});

test('reconciliation is complete only when every site has a disposition', () => {
  const recall = {
    sites: [
      site({ siteKey: 'a', bucket: 'caught' }),
      site({ siteKey: 'b', kind: 'catch' }),
      site({ siteKey: 'c' }), // matches nothing
    ],
  };
  const r = reconcile(recall, CLASSES);
  assert.equal(r.total, 3);
  assert.equal(r.caught, 1);
  assert.equal(r.missedAssignedToClass, 1);
  assert.equal(r.unassigned, 1);
  assert.equal(r.complete, false, 'an unassigned site must block completion');
});

test('reconciliation reports complete when all sites are dispositioned', () => {
  const recall = {
    sites: [site({ siteKey: 'a', bucket: 'caught' }), site({ siteKey: 'b', kind: 'catch' })],
  };
  const r = reconcile(recall, CLASSES);
  assert.equal(r.complete, true);
  assert.equal(r.total_accounted, r.total, 'accounting must be total');
});

test('every bucket is counted exactly once — no site is double-counted', () => {
  const recall = {
    sites: [
      site({ siteKey: 'a', bucket: 'caught' }),
      site({ siteKey: 'b', bucket: 'caught-but-suppressed' }),
      site({ siteKey: 'c', bucket: 'not-mechanically-expressible' }),
      site({ siteKey: 'd', bucket: 'missed', kind: 'catch' }),
    ],
  };
  const r = reconcile(recall, CLASSES);
  assert.equal(
    r.caught + r.suppressed + r.declaredHumanReview + r.missedAssignedToClass + r.unassigned,
    4,
  );
  assert.equal(r.complete, true);
});

test('findings outside the ledger become deduplicated addenda', () => {
  const recall = {
    sites: [],
    unmatchedFindings: [
      { filePath: 'x.ts', ruleId: 'r', line: 1 },
      { filePath: 'x.ts', ruleId: 'r', line: 1 },
      { filePath: 'y.ts', ruleId: 'r', line: 2 },
    ],
  };
  const r = reconcile(recall, CLASSES);
  assert.equal(r.addenda.length, 2, 'the same finding must not be added twice');
  assert.equal(r.addenda[0].origin, 'check-fired-outside-ledger');
});
