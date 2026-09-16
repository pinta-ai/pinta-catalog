#!/usr/bin/env node
// Decide which `manager-v*` line tags may be force-moved to a given commit.
//
//   bun scripts/move-line-tags.mjs --target <sha> [--apply]
//
// A `manager-v{X.Y.Z}` tag is a MOVING pointer, not a frozen snapshot: a manager
// in Layer-2 fallback reads the catalog *through* its tag, so a tag left behind
// pins that manager to the catalog as it existed the day it shipped. Advancing
// it is what keeps old managers current. See docs/manager-compat.md.
//
// Re-dispatching every line by hand after every adaptor release was the previous
// arrangement, and it was missed twice in a row (0.1.8 and 0.1.9 went untagged
// while 0.1.7 sat five months stale). This script is that step, done mechanically.
//
// It moves a line only when moving is provably safe for that line:
//
//   • SCHEMA BUMP — if `schema_version` at the tag's current commit differs from
//     the target's, the line is parked on purpose. Rule 2 of the publishing
//     discipline says to pin the old lines *before* a bump; moving one past it
//     would repoint that manager at an index it cannot parse and collapse the
//     middle rung of its fallback chain. Skip, permanently — the tag stays where
//     a human put it.
//   • INDEX FLOOR — if the target index declares `minimumRequiredManagerVersion`
//     above the line, that index is by declaration too new for it. Skip.
//
// Everything else is safe by construction: the additive-schema discipline means
// a newer index stays readable, and per-adaptor isolation in the manager means a
// manifest the line cannot parse is skipped rather than fatal.
//
// Without --apply this only reports, and never writes. Exit 1 on error.

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const targetIdx = args.indexOf('--target');
const target = targetIdx === -1 ? 'HEAD' : args[targetIdx + 1];
if (!target) {
  console.error('usage: move-line-tags.mjs --target <sha|ref> [--apply]');
  process.exit(1);
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

/** The index as committed at a revision, or null when it is absent/unreadable. */
function indexAt(rev) {
  let raw;
  try {
    raw = execFileSync('git', ['show', `${rev}:catalog/index.json`], { encoding: 'utf8' });
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** -1 / 0 / 1 on the numeric release triple. Lines never carry a prerelease. */
function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

const targetSha = git('rev-parse', target);
const targetIndex = indexAt(targetSha);
if (!targetIndex) {
  console.error(`::error::catalog/index.json is missing or unparseable at ${target}`);
  process.exit(1);
}
const targetSchema = targetIndex.schema_version;
const targetFloor = targetIndex.minimumRequiredManagerVersion ?? null;

const tags = git('tag', '--list', 'manager-v*')
  .split('\n')
  .map((t) => t.trim())
  .filter(Boolean)
  .filter((t) => /^manager-v\d+\.\d+\.\d+$/.test(t))
  .sort((a, b) => cmp(a.slice('manager-v'.length), b.slice('manager-v'.length)));

if (tags.length === 0) {
  console.log('no manager-v* line tags exist yet — nothing to move');
  process.exit(0);
}

const moved = [];
const skipped = [];

for (const tag of tags) {
  const line = tag.slice('manager-v'.length);
  const at = git('rev-list', '-n', '1', tag);

  if (at === targetSha) {
    skipped.push([tag, 'already at target']);
    continue;
  }
  if (targetFloor && cmp(line, targetFloor) < 0) {
    skipped.push([tag, `index declares minimumRequiredManagerVersion ${targetFloor}`]);
    continue;
  }
  const tagIndex = indexAt(at);
  if (!tagIndex) {
    skipped.push([tag, 'index unreadable at its current commit — parked by hand, left alone']);
    continue;
  }
  if (tagIndex.schema_version !== targetSchema) {
    skipped.push([
      tag,
      `schema_version ${tagIndex.schema_version} -> ${targetSchema}: parked before a bump`,
    ]);
    continue;
  }

  if (apply) git('tag', '-f', tag, targetSha);
  moved.push([tag, at.slice(0, 8)]);
}

const verb = apply ? 'moved' : 'would move';
for (const [tag, from] of moved) console.log(`${verb.padEnd(10)} ${tag}  ${from} -> ${targetSha.slice(0, 8)}`);
for (const [tag, why] of skipped) console.log(`${'skipped'.padEnd(10)} ${tag}  (${why})`);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const lines = ['### Manager line tags', '', '| tag | result |', '| --- | --- |'];
  for (const [tag, from] of moved) lines.push(`| \`${tag}\` | ${verb} from \`${from}\` |`);
  for (const [tag, why] of skipped) lines.push(`| \`${tag}\` | skipped — ${why} |`);
  execFileSync('bash', ['-c', `cat >> "$GITHUB_STEP_SUMMARY"`], { input: lines.join('\n') + '\n' });
}

if (apply && moved.length > 0) {
  git('push', '--force', 'origin', ...moved.map(([tag]) => `refs/tags/${tag}`));
  console.log(`pushed ${moved.length} tag(s)`);
}
