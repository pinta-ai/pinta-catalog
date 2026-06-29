# Manager compatibility & catalog releases

The Pinta Manager fetches this catalog at runtime. Old managers (not yet
upgraded) keep reading the **latest** catalog, so the catalog must stay
backward-compatible — or tell old managers, in a way they understand, to step
down. This doc describes the contract and the publishing discipline that keeps
it working.

> Design: `pinta-manager` → `docs/features/v0.1.8/catalog-version-compat.md`.

## What the manager understands

Two **optional** fields, both `Semver` strings, let the catalog declare a
minimum manager version. Managers that predate the feature simply ignore them
(unknown keys are stripped on parse).

### Per-manifest floor (preferred)

```jsonc
// catalog/index.json — adaptors[].manifests[]
{
  "version": "2.0.0",
  "url": "pinta-cc/2.0.0.yaml",
  "sha256": "…",
  "minimumRequiredManagerVersion": "0.1.8"   // ← needs manager ≥ 0.1.8
}
```

The manager installs the **newest manifest whose floor ≤ its own version**, not
blindly `latest`. So an old `0.1.7` manager skips the `2.0.0` entry above and
installs the newest manifest it *can* run (e.g. `1.4.1`). This is how an old
manager keeps using the **last catalog/wrapper version it supports** — no extra
infrastructure required, as long as old manifests stay listed (see discipline
below).

### Index-level floor (format breaks only)

```jsonc
// catalog/index.json — top level
{
  "schema_version": 1,
  "minimumRequiredManagerVersion": "0.2.0",   // ← whole index needs manager ≥ 0.2.0
  "generated": "…",
  "adaptors": [ … ]
}
```

Use this **only** when the index format itself outgrows old managers. When a
manager is below this floor (or can't parse the index at all), it falls back:

```
main index → manager-v{X.Y.Z} tag snapshot → last-good local cache
```

## Publishing discipline

These rules keep already-shipped managers working. Breaking them can brick old
clients (they auto-update on a delay, so there's always a tail of old versions).

1. **Schema additive only.** Add new fields as optional. Never rename or remove
   a field that current managers read.
2. **Do not bump `schema_version` (the `z.literal(1)`) casually.** The moment it
   changes, every manager that predates the bump fails to parse the index and
   drops to its tag/cache fallback. If a bump is truly required, publish the
   `manager-v*` tags (below) *first* so the fallback target exists, and set the
   top-level `minimumRequiredManagerVersion`.
3. **Keep old manifests listed.** Never prune a `manifests[]` entry that an
   in-the-wild manager might still resolve to. Per-manifest fallback only works
   if the older version is still there to fall back to.
4. **Tag every manager release.** See below.

## Tagging a manager release

For each manager release line `X.Y.Z`, create a git tag `manager-vX.Y.Z`
pointing at the catalog commit that is **known-compatible** with that manager.
`raw.githubusercontent.com/pinta-ai/pinta-catalog/manager-vX.Y.Z/catalog/index.json`
then resolves to a guaranteed-parseable snapshot for that manager's fallback.

Prereleases collapse onto their line: a `0.1.7-rc.10` manager derives the tag
`manager-v0.1.7` (the `-rc.N` suffix is dropped).

Tags are **fixed snapshots**, not moving pointers — the manager tries `main`
first and only falls to its tag when `main` is incompatible, so the tag just
needs to be *a* compatible snapshot, not the latest one.

```bash
# from a clean checkout, with the desired catalog state on main:
scripts/tag-manager-release.sh 0.1.7        # creates + pushes manager-v0.1.7 at origin/main
scripts/tag-manager-release.sh 0.1.7 --dry-run
```

This should eventually run from the manager's release pipeline; until then, run
it by hand when a new manager release line ships.
