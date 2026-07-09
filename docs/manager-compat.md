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

   The one exception: a **superseded manifest that is already un-resolvable** —
   its `sha256` no longer matches its YAML, so any manager fetching it rejects it
   — may be deleted. It is not a fallback target; it only looks like one. Keeping
   it would mean re-hashing the index to bless an in-place edit of a published
   manifest, which rule 5 forbids. `scripts/check-index-diff.mjs` enforces this
   distinction: it blocks removing a *healthy* old manifest, and allows removing
   an already-broken one.
4. **Tag every manager release.** See below.
5. **Published manifests are immutable.** Never edit a shipped
   `<id>/<version>.yaml` in place — its `sha256` is already published in
   `index.json`, and managers verify it. Publish a new version instead.

## Tagging a manager release

For each manager release line `X.Y.Z`, create a git tag `manager-vX.Y.Z`
pointing at the catalog commit that is **known-compatible** with that manager.
`raw.githubusercontent.com/pinta-ai/pinta-catalog/manager-vX.Y.Z/catalog/index.json`
then resolves to a guaranteed-parseable snapshot for that manager's fallback.

Prereleases collapse onto their line: a `0.1.7-rc.10` manager derives the tag
`manager-v0.1.7` (the `-rc.N` suffix is dropped).

Cut the tag with the **Tag manager release** workflow. It runs *inside* this
repo, so the built-in `GITHUB_TOKEN` already has `contents: write` — no
cross-repo PAT or App secret is stored anywhere. (A workflow in `pinta-manager`
could not do this: its token is scoped to `pinta-manager`.)

```bash
gh workflow run tag-manager-release.yml --ref main -f manager_version=0.1.7 --repo pinta-ai/pinta-catalog
```

or Actions UI → **Tag manager release** → Run workflow → pick the branch, enter
the version. See [`../PUBLISHING.md`](../PUBLISHING.md).

The tag is cut at the **HEAD of the branch the workflow was dispatched on**, and
is **force-moved** there if it already exists.

A `manager-v*` tag is a **moving pointer, not a frozen snapshot** — re-dispatch it
whenever new wrapper versions land. A manager in Layer-2 fallback reads the
catalog *through* its tag, so a tag frozen at release time would pin that manager
to the catalog as it existed the day it shipped: still running, but never seeing
any adaptor version published afterwards. Advancing the tag is what keeps old
managers current. (This is also why create-if-absent is wrong here: every rc
collapses onto one release line, so the tag would freeze at the first rc.)

The invariant is not immutability but **parseability**: the tag must point at a
catalog state that manager version can still read. `main` satisfies that by
construction — the additive-schema discipline above is exactly what guarantees it
— so tracking `main` HEAD is safe.

The one exception is a **`schema_version` bump**, which by definition makes `main`
unparseable to older managers. That is why rule 2 says to publish the `manager-v*`
tags *first*, pinned at the last pre-bump commit: after the bump, dispatching an
old line from `main` would repoint its tag at a state that manager cannot read,
collapsing the middle rung of the fallback chain and dropping it to the last-good
local cache. The workflow cannot detect this — once a line's tag is parked ahead
of a bump, stop re-dispatching it.
