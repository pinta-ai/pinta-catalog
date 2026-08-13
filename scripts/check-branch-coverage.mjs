#!/usr/bin/env node
// Delivery-coverage check: which adaptors on `main` are missing from the branches
// that shipped managers actually read?
//
//   bun scripts/check-branch-coverage.mjs           # report; exit 0 (advisory)
//   bun scripts/check-branch-coverage.mjs --strict  # exit 1 if any adaptor is missing
//   bun scripts/check-branch-coverage.mjs --json    # machine-readable
//
// WHY THIS EXISTS
//
// Merging an adaptor to `main` does not deliver it. A manager resolves its catalog
// through `catalogBranch` (a backend-pushed feature flag), which points at a
// `release/v*` branch — see pinta-manager sidecar/src/catalog/config.ts. `main` is
// only the fallback when no flag is set.
//
// pinta-musecode 0.1.2 was published to npm and merged to `main`, and was still
// invisible to every manager, because no release branch carried its manifest. The
// existing checks could not see it: catalog:check validates ONE revision against
// itself, and check-index-diff.mjs compares a PR to ITS OWN base. Nothing compares
// branches, so "shipped to main, delivered to nobody" was not a representable
// failure. This script makes it one.
//
// Advisory by default: a release branch is a frozen line owned by whoever cut it,
// so a `main` PR must not be blocked by it. Use --strict where you want a gate.

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const JSON_OUT = args.includes('--json');
const BASE = arg('--base') ?? 'main';

function arg(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf-8' }).trim();

// Read a committed index.json without checking the ref out — the working tree stays
// untouched, so this is safe to run mid-edit and in a shallow-ish CI clone.
function readIndexAt(ref) {
  try {
    return JSON.parse(git('show', `${ref}:catalog/index.json`));
  } catch {
    return null;
  }
}

// A release line is the full `x.y.z` (`release/v0.1.9-rc.1` → line 0.1.9); the `-rc.N`
// suffix is an iteration within it, so only the newest rc per line is inspected.
//
// Only the most recently updated line is ACTIVE — the one a manager can currently be
// pointed at. Older lines are frozen history: reported for context, never gated on,
// because backporting into a shipped line is not something a `main` merge owes.
function releaseBranches() {
  const refs = git('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/release/*')
    .split('\n')
    .filter(Boolean)
    .map((r) => r.replace(/^origin\//, ''));

  const newestPerLine = new Map();
  for (const ref of refs) {
    const m = ref.match(/^release\/v(\d+\.\d+\.\d+)/);
    if (!m) continue;
    const line = m[1];
    const committed = Number(git('log', '-1', '--format=%ct', `origin/${ref}`));
    const prev = newestPerLine.get(line);
    if (!prev || committed > prev.committed) newestPerLine.set(line, { ref, committed });
  }

  const lines = [...newestPerLine.entries()]
    .map(([line, v]) => ({ line, ref: v.ref, committed: v.committed }))
    .sort((a, b) => b.committed - a.committed);

  return lines.map((l, i) => ({ ...l, active: i === 0 }));
}

const baseIndex = readIndexAt(`origin/${BASE}`) ?? readIndexAt(BASE);
if (!baseIndex) {
  console.error(`✗ cannot read catalog/index.json at ${BASE}`);
  process.exit(1);
}

const baseAdaptors = new Map((baseIndex.adaptors ?? []).map((a) => [a.id, a.latest]));
const branches = releaseBranches();

const report = [];
for (const { line, ref, committed, active } of branches) {
  const idx = readIndexAt(`origin/${ref}`);
  if (!idx) {
    report.push({ line, ref, active, unreadable: true, missing: [], stale: [] });
    continue;
  }
  const have = new Map((idx.adaptors ?? []).map((a) => [a.id, a.latest]));

  const missing = [...baseAdaptors.keys()].filter((id) => !have.has(id));

  // Present on both, but the branch carries an older `latest`. Not a delivery gap —
  // a release line legitimately freezes — so it is reported separately, never gated.
  const stale = [...baseAdaptors.entries()]
    .filter(([id, latest]) => have.has(id) && have.get(id) !== latest)
    .map(([id, latest]) => ({ id, base: latest, branch: have.get(id) }));

  report.push({
    line,
    ref,
    active,
    updated: new Date(committed * 1000).toISOString().slice(0, 10),
    missing,
    stale,
  });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ base: BASE, adaptors: [...baseAdaptors.keys()], branches: report }, null, 2));
} else {
  console.log(`Delivery coverage — adaptors on \`${BASE}\` vs the branches managers read\n`);
  console.log(`  ${BASE}: ${baseAdaptors.size} adaptors (${[...baseAdaptors.keys()].join(', ')})\n`);

  if (!report.length) console.log('  (no release/v* branches found)');

  for (const b of report) {
    const tag = b.active ? 'ACTIVE' : 'frozen';
    if (b.unreadable) {
      console.log(`  ${b.ref} [${tag}]: catalog/index.json unreadable — skipped`);
      continue;
    }
    const head = `  ${b.ref} [${tag}]  (updated ${b.updated})`;
    if (!b.missing.length) {
      console.log(`${head}  ✓ all ${baseAdaptors.size} present`);
    } else {
      console.log(`${head}  ✗ MISSING ${b.missing.length}: ${b.missing.join(', ')}`);
    }
    for (const s of b.stale) {
      console.log(`      · ${s.id} is ${s.branch} here, ${s.base} on ${BASE}`);
    }
  }

  const gaps = report.filter((b) => b.active && b.missing.length);
  if (gaps.length) {
    const ids = [...new Set(gaps.flatMap((b) => b.missing))].join(', ');
    console.log(
      `\n  The ACTIVE release line cannot deliver: ${ids}` +
        `\n  Managers resolve the catalog via the \`catalogBranch\` flag, not ${BASE}, so these` +
        `\n  are invisible to every user on that line. Backport with a PR against the branch:` +
        `\n    git checkout origin/${BASE} -- catalog/<id>/<version>.yaml && bun run catalog:build` +
        `\n  See PUBLISHING.md → "Delivery: main is not a release channel".`,
    );
  }
}

const missingCount = report.reduce((n, b) => n + (b.active ? b.missing.length : 0), 0);
process.exit(STRICT && missingCount ? 1 : 0);
