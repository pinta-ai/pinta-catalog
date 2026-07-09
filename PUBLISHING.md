# Publishing the catalog

The catalog is served as **raw GitHub content off `main`**:
`https://raw.githubusercontent.com/pinta-ai/pinta-catalog/main/catalog/index.json`.
Managers fetch `index.json`, then each manifest YAML, verifying a **sha256 chain**
(index → manifest file → npm tarball) at every hop. A single wrong hash, a dropped
old version, or an accidental format bump can break managers in the field.

To make those mistakes **mechanical to catch instead of remembered**, `index.json`
is **generated**, never hand-edited, and every change is validated in CI
(`.github/workflows/validate-catalog.yml`).

> Background & the compatibility model this enforces:
> `pinta-ai/pinta-manager` → `docs/features/v0.1.8/catalog-version-compat.md`
> (§0.4 field-is-not-protection, §2 publishing discipline, §2.1 schema_version → main2,
> §2.2 using `minimumRequiredManagerVersion`).

## Tooling

The scripts have **no dependencies** — YAML parsing and version ordering come from
bun's built-in `Bun.YAML` and `Bun.semver`, so there is nothing to install.

| Command | What |
|---------|------|
| `bun run catalog:build` | regenerate `catalog/index.json` from the manifest YAMLs + `catalog.config.json` (computes sha256, sets `latest`, sorts) |
| `bun run catalog:check` | validate without writing (what CI runs) |
| `bun run catalog:verify-artifacts` | `catalog:check` + fetch every npm tarball and check `artifact.sha256` |

## Add / update an adaptor version (the happy path)

1. **Add a NEW manifest** `catalog/<id>/<version>.yaml`. Never edit an already-published
   `<version>.yaml` — publish a new version instead (see "Immutability" below).
2. Run **`bun run catalog:build`** — this recomputes every sha256 and rewrites
   `index.json`. Do not hand-edit `index.json`.
3. Run **`bun run catalog:verify-artifacts`** to confirm the npm tarball hashes.
4. Open a PR. CI must be green before merge. Merge to `main` to publish.

## `latest` and compatibility floors

- `latest` is set by the generator to the **newest floor-blind-safe version** — the
  newest version an old manager that doesn't understand floors can safely install
  (it installs `latest` blindly). While pre-v0.1.8 managers exist, that means the
  newest **floor-free** version. Do not point `latest` at a floor-gated version by
  hand; the generator won't, and CI blocks it. (Why: §0.4 / §2.2.)
- To gate a version behind a manager version, add it to
  `catalog.config.json → manifestFloors`, e.g. `{ "pinta-cc": { "2.0.0": "0.1.8" } }`.
  Floor-aware managers auto-pick the newest version they support; older ones stay on
  `latest`. Floors live in config (not the YAML) so they never touch the manager's
  manifest schema.
- Raising `oldestSupportedFloorBlind` (letting `latest` advance into floored versions)
  is a deliberate call — only once the old cohort is retired.

## Immutability & pruning

- **Published manifests are immutable.** A shipped `<id>/<version>.yaml` must not be
  edited in place — managers verify its old sha and would reject the changed file.
  CI (`check-index-diff.mjs`) blocks in-place edits. Need a change? Publish a new
  version.
- **Keep old manifests** — they are the Layer-1 downgrade targets. CI blocks removing
  a healthy old version.
- **Exception (sanctioned):** a version that is *already broken* (its `index.json`
  sha doesn't match its YAML) has no downgrade value — if a newer version supersedes
  it, **delete it**. CI auto-allows removing an already-broken manifest.
- **Never bump `schema_version` on `main`.** Pre-v0.1.8 managers have no fallback and
  hard-fail on an unparseable index. A real format change goes on a **new default
  branch** (`main2`), not `main` — see §2.1. `expectedSchemaVersion` in
  `catalog.config.json` guards accidental bumps.

## Per manager release: tag `manager-v{x.y.z}`

Every manager release needs a `manager-v{x.y.z}` tag on this repo, pointing at a
catalog state whose `index.json` is parseable by that manager. It is the
guaranteed Layer-2 fallback when a future `main` is incompatible.

Cut it with the **Tag manager release** workflow — it runs here, so the built-in
token creates the tag (no secret needed):

```bash
gh workflow run tag-manager-release.yml --ref main -f manager_version=0.1.8 --repo pinta-ai/pinta-catalog
```

or Actions UI → **Tag manager release** → Run workflow → pick the branch, enter
the version. rc collapses to the release line (`0.1.8-rc.1` → `manager-v0.1.8`).

The tag is cut at the **HEAD of the branch the workflow was dispatched on** (`--ref`,
or the UI branch dropdown), and is **force-moved** there if it already exists.

Re-dispatch it as new wrapper versions land: a manager in Layer-2 fallback reads the
catalog through its tag, so a tag left behind pins that manager to the catalog as of
its release day. The invariant is that the tag stays **parseable** by that manager —
see [`docs/manager-compat.md`](docs/manager-compat.md), which covers the one case
where it must stop advancing (a `schema_version` bump).

> A workflow in **pinta-manager** can't do this — its `GITHUB_TOKEN` is scoped to
> pinta-manager and can't tag another repo. That's why the tagging job lives here.

## Never do

- Hand-edit `index.json` (sha256, `latest`, the manifest list).
- Edit an already-published `<version>.yaml`.
- Remove a healthy old manifest version.
- Point `latest` at a floor-gated version while floor-blind managers exist.
- Bump `schema_version` on `main`.
