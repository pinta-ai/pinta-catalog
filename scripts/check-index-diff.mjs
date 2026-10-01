#!/usr/bin/env node
// Diff the catalog index between a base and head checkout and enforce the
// history rules that a single-revision check can't see:
//
//   bun scripts/check-index-diff.mjs <base-catalog-dir> <head-catalog-dir>
//
// where each arg is a `catalog/` directory (containing index.json + <id>/<ver>.yaml).
//
// Rules:
//   • PUBLISHED MANIFESTS ARE IMMUTABLE. If an (id@version) exists in both base and
//     head but its YAML content changed, that's an in-place edit of a shipped
//     manifest (managers verify the old sha and would reject it). BLOCK — publish a
//     NEW version instead, or delete the old one if it's superseded.
//   • DON'T DROP HEALTHY OLD MANIFESTS. Removing an (id@version) that was intact in
//     base breaks the Layer-1 downgrade premise (an older manager steps down to it).
//     BLOCK.
//   • …EXCEPT superseded + already-broken ones. If the removed version was ALREADY
//     broken in base (its base index sha256 didn't match its base YAML, or the file
//     was missing), it had no downgrade value anyway — allow the deletion. This is
//     the sanctioned "다른 버전이 위에 있으면 mismatching 과거 버전은 지운다" path.
//
// Exit 1 on any blocking finding.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [, , baseDir, headDir] = process.argv;
if (!baseDir || !headDir) {
  console.error('usage: check-index-diff.mjs <base-catalog-dir> <head-catalog-dir>');
  process.exit(2);
}

// null ONLY when the file is genuinely absent (ENOENT) — a legitimate "new/first
// commit" skip. A present-but-unparseable index (corrupt/half-written) must NOT be
// mistaken for "missing" and silently disable the history guards below; surface it.
const readIndex = (dir) => {
  const p = path.join(dir, 'index.json');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e; // permission/IO error — real, don't swallow
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`✗ ${p} exists but is not valid JSON (corrupt index): ${e.message}`);
    process.exit(1);
  }
};
const fileSha = (dir, url) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, url))).digest('hex');
  } catch {
    return null;
  }
};

// Flatten index -> Map "id@ver" -> { url, indexSha }
const flatten = (idx) => {
  const m = new Map();
  for (const a of idx?.adaptors ?? []) {
    for (const man of a.manifests ?? []) m.set(`${a.id}@${man.version}`, { url: man.url, indexSha: man.sha256 });
  }
  return m;
};

const base = readIndex(baseDir);
if (!base) {
  console.log('no readable base index — skipping history diff (new/first commit).');
  process.exit(0);
}
const head = readIndex(headDir);
if (!head) {
  console.error('✗ head catalog/index.json is missing or unreadable.');
  process.exit(1);
}

const baseM = flatten(base);
const headM = flatten(head);
const errors = [];

for (const [key, b] of baseM) {
  const baseFileSha = fileSha(baseDir, b.url);
  const brokenInBase = baseFileSha == null || baseFileSha !== b.indexSha;
  const h = headM.get(key);

  if (!h) {
    // removed
    if (brokenInBase) {
      console.log(`  ~ ${key} removed (was already broken in base) — allowed.`);
    } else {
      errors.push(`${key} removed, but it was intact — keep old manifests for Layer-1 downgrade (publish forward instead of pruning healthy versions).`);
    }
    continue;
  }

  // survived — check for in-place mutation of a healthy published manifest
  if (!brokenInBase) {
    const headFileSha = fileSha(headDir, h.url);
    if (headFileSha != null && headFileSha !== baseFileSha) {
      errors.push(`${key} was edited in place (published manifest is immutable) — publish a NEW version, or delete this one if it's superseded.`);
    }
  }
}

if (errors.length) {
  console.error(`✗ catalog history check failed (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('✓ catalog history OK (no healthy removals, no in-place edits of published manifests).');
