#!/usr/bin/env node
// Catalog index generator + validator.
//
//   bun scripts/catalog-build.mjs            # write mode: regenerate catalog/index.json from disk + config
//   bun scripts/catalog-build.mjs --check    # validate only, no write; exit 1 on any problem (CI)
//   bun scripts/catalog-build.mjs --verify-artifacts [file.yaml ...]
//                                             # also fetch each manifest's npm tarball and check artifact.sha256
//                                             # (no files => all manifests). Network; scope it in CI.
//
// The index is DERIVED from the manifest YAML files on disk + catalog.config.json.
// Humans never hand-type sha256, the manifest list, or `latest`; this script does,
// so the whole class of hand-edit mistakes can't reach `main`. See PUBLISHING.md.
//
// Invariants enforced (all fail --check):
//   • every manifest YAML parses and matches its path (id == dir, version == filename, valid semver)
//   • manifests[].sha256 == sha256(the YAML file)               ← kills stale/wrong hashes
//   • artifact.sha256 is a 64-hex string (and, with --verify-artifacts, matches the real tarball)
//   • schema_version == config.expectedSchemaVersion            ← guards an accidental format bump
//   • floors are valid semver; `latest` is floor-blind-safe     ← §0.4/§2.2 traps
//   • committed index.json equals what this script would generate (ignoring `generated`)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const parseYaml = Bun.YAML.parse;

// `Bun.semver` only ships { satisfies, order } — there is no `valid`, and neither
// primitive substitutes for one: `order("1.2", "1.2.3")` happily returns 1 and
// `satisfies("1.2.3.4", "1.2.3.4")` is true, though node-semver rejects both. So
// validity is its own strict check (the official semver.org regex), and ordering
// delegates to Bun.semver.order — which throws on input this regex would reject.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const isSemver = (v) => typeof v === 'string' && SEMVER_RE.test(v);
const lte = (a, b) => Bun.semver.order(a, b) <= 0;
const rcompare = (a, b) => Bun.semver.order(b, a); // newest first

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIR = path.join(ROOT, 'catalog');
const INDEX_PATH = path.join(CATALOG_DIR, 'index.json');
const CONFIG_PATH = path.join(ROOT, 'catalog.config.json');
const HEX64 = /^[0-9a-f]{64}$/;

const errors = [];
const fail = (msg) => errors.push(msg);

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return {
    expectedSchemaVersion: cfg.expectedSchemaVersion ?? 1,
    oldestSupportedFloorBlind: cfg.oldestSupportedFloorBlind ?? null,
    indexMinimumRequiredManagerVersion: cfg.indexMinimumRequiredManagerVersion ?? null,
    manifestFloors: cfg.manifestFloors && typeof cfg.manifestFloors === 'object' ? cfg.manifestFloors : {},
  };
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Every version this adaptor can be `latest` for a manager that does NOT understand
// floors (pre-v0.1.8: installs `latest` blindly). Floor-free is safe for everyone;
// a floored version is only latest-eligible when its floor <= the oldest cohort we
// still protect. null oldest => only floor-free versions qualify (safe default).
function latestEligible(floor, oldest) {
  if (!floor) return true;
  if (oldest == null) return false;
  return lte(floor, oldest);
}

// Build the expected index model from disk + config. Returns { model, adaptorOrder }.
function buildModel(config) {
  const floorCfg = config.manifestFloors;

  // Validate floor config values up front.
  for (const [id, byVer] of Object.entries(floorCfg)) {
    if (id.startsWith('//')) continue;
    for (const [ver, floor] of Object.entries(byVer)) {
      if (ver.startsWith('//')) continue;
      if (!isSemver(floor)) fail(`manifestFloors[${id}][${ver}] = "${floor}" is not valid semver`);
    }
  }
  if (config.indexMinimumRequiredManagerVersion != null && !isSemver(config.indexMinimumRequiredManagerVersion)) {
    fail(`indexMinimumRequiredManagerVersion = "${config.indexMinimumRequiredManagerVersion}" is not valid semver`);
  }
  // Guard before latestEligible() hands it to Bun.semver.order, which throws on bad input.
  if (config.oldestSupportedFloorBlind != null && !isSemver(config.oldestSupportedFloorBlind)) {
    fail(`oldestSupportedFloorBlind = "${config.oldestSupportedFloorBlind}" is not valid semver`);
  }

  const adaptorIds = fs
    .readdirSync(CATALOG_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const adaptors = [];
  for (const id of adaptorIds) {
    const dir = path.join(CATALOG_DIR, id);
    const yamls = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    if (yamls.length === 0) {
      fail(`adaptor "${id}" has no manifest YAML files`);
      continue;
    }

    const manifests = [];
    for (const file of yamls) {
      const version = file.replace(/\.yaml$/, '');
      const full = path.join(dir, file);
      let obj;
      try {
        obj = parseYaml(fs.readFileSync(full, 'utf-8'));
      } catch (e) {
        fail(`${id}/${file}: YAML parse error: ${e.message}`);
        continue;
      }
      if (!isSemver(version)) {
        // Skip it: the sort below feeds versions to Bun.semver.order, which throws
        // on invalid input and would mask this (and every other) error message.
        fail(`${id}/${file}: filename "${version}" is not valid semver`);
        continue;
      }
      if (obj?.schema_version !== config.expectedSchemaVersion) {
        fail(`${id}/${file}: schema_version ${obj?.schema_version} != expected ${config.expectedSchemaVersion}`);
      }
      if (obj?.id !== id) fail(`${id}/${file}: manifest id "${obj?.id}" != directory "${id}"`);
      if (obj?.version !== version) fail(`${id}/${file}: manifest version "${obj?.version}" != filename "${version}"`);
      const artSha = obj?.artifact?.sha256;
      if (!artSha || !HEX64.test(String(artSha))) {
        fail(`${id}/${file}: artifact.sha256 missing or not 64-hex`);
      }

      const floor = floorCfg[id]?.[version];
      const entry = { version, url: `${id}/${file}`, sha256: sha256File(full) };
      if (floor) entry.minimumRequiredManagerVersion = floor;
      manifests.push(entry);
    }

    manifests.sort((a, b) => rcompare(a.version, b.version)); // newest first

    // latest = highest floor-blind-safe version.
    const eligible = manifests.filter((m) => latestEligible(m.minimumRequiredManagerVersion, config.oldestSupportedFloorBlind));
    let latest;
    if (eligible.length === 0) {
      fail(
        `adaptor "${id}": no floor-blind-safe version to use as \`latest\` ` +
          `(every manifest has a floor > oldestSupportedFloorBlind=${config.oldestSupportedFloorBlind}). ` +
          `Add a floor-free build, or retire the old cohort and raise oldestSupportedFloorBlind.`,
      );
      latest = manifests[0]?.version; // best effort so the rest of the report still renders
    } else {
      latest = eligible.map((m) => m.version).sort(rcompare)[0];
    }

    adaptors.push({ id, latest, manifests });
  }

  const model = { schema_version: config.expectedSchemaVersion };
  if (config.indexMinimumRequiredManagerVersion != null) {
    model.minimumRequiredManagerVersion = config.indexMinimumRequiredManagerVersion;
  }
  model.adaptors = adaptors;
  return model;
}

// Order-insensitive, `generated`-insensitive normalization for comparison.
function normalize(index) {
  const adaptors = [...(index.adaptors ?? [])]
    .map((a) => ({
      id: a.id,
      latest: a.latest,
      manifests: (a.manifests ?? []).map((m) => ({
        version: m.version,
        url: m.url,
        sha256: m.sha256,
        floor: m.minimumRequiredManagerVersion ?? null,
      })),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({
    schema_version: index.schema_version,
    minimumRequiredManagerVersion: index.minimumRequiredManagerVersion ?? null,
    adaptors,
  });
}

// Canonical on-disk form: preserve existing adaptor order (minimise churn), new ones appended.
function serialize(model, existing, generated) {
  const order = new Map((existing?.adaptors ?? []).map((a, i) => [a.id, i]));
  const adaptors = [...model.adaptors].sort((a, b) => {
    const ia = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
    const ib = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
    return ia !== ib ? ia - ib : a.id.localeCompare(b.id);
  });
  const out = { schema_version: model.schema_version };
  if (model.minimumRequiredManagerVersion != null) out.minimumRequiredManagerVersion = model.minimumRequiredManagerVersion;
  out.generated = generated;
  out.adaptors = adaptors;
  return JSON.stringify(out, null, 2) + '\n';
}

async function verifyArtifacts(model, files) {
  // Map url -> manifest yaml relative path to know which artifacts to check.
  const wanted = files && files.length ? new Set(files.map((f) => f.replace(/^catalog\//, ''))) : null;
  for (const a of model.adaptors) {
    for (const m of a.manifests) {
      if (wanted && !wanted.has(m.url)) continue;
      const yamlPath = path.join(CATALOG_DIR, m.url);
      const obj = parseYaml(fs.readFileSync(yamlPath, 'utf-8'));
      const { url, sha256: expected } = obj.artifact ?? {};
      if (!url) { fail(`${m.url}: artifact.url missing`); continue; }
      let buf;
      try {
        const res = await fetch(url);
        if (!res.ok) { fail(`${m.url}: artifact fetch ${url} -> HTTP ${res.status}`); continue; }
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        fail(`${m.url}: artifact fetch ${url} failed: ${e.message}`);
        continue;
      }
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got !== expected) fail(`${m.url}: artifact.sha256 mismatch — declared ${expected}, tarball ${got}`);
      else console.log(`  ✓ artifact ${m.url} sha256 ok`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const verify = args.includes('--verify-artifacts');
  const verifyFiles = args.filter((a) => a.endsWith('.yaml'));

  const config = loadConfig();
  const existing = fs.existsSync(INDEX_PATH) ? JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8')) : null;
  const model = buildModel(config);

  if (verify) await verifyArtifacts(model, verifyFiles);

  if (check) {
    if (!existing) fail('catalog/index.json does not exist');
    else {
      if (typeof existing.generated !== 'string' || Number.isNaN(Date.parse(existing.generated))) {
        fail(`index.json "generated" is not a valid ISO-8601 timestamp: ${existing.generated}`);
      }
      if (normalize(existing) !== normalize(model)) {
        fail('catalog/index.json is out of sync with the manifests/config. Run `bun run catalog:build` and commit.');
      }
    }
    if (errors.length) {
      console.error(`✗ catalog check failed (${errors.length}):`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log('✓ catalog/index.json is consistent with manifests + config.');
    return;
  }

  // write mode
  if (errors.length) {
    console.error(`✗ refusing to write — fix these first (${errors.length}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  // Preserve `generated` when nothing changed, else stamp now.
  const same = existing && normalize(existing) === normalize(model);
  const generated = same ? existing.generated : new Date().toISOString();
  fs.writeFileSync(INDEX_PATH, serialize(model, existing, generated));
  console.log(same ? 'catalog/index.json already up to date (no content change).' : `catalog/index.json regenerated (generated=${generated}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
