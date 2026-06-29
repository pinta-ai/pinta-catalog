# pinta-catalog seed

This directory contains the initial content for the `awarecorp/pinta-catalog` GitHub repository.

## Setup

1. Create private GitHub repository `awarecorp/pinta-catalog`.
2. Clone it locally.
3. Copy this directory's contents into the repo.
4. Replace the `sha256` fields in `catalog/index.json` and `catalog/mcp-logger/1.0.0.yaml`
   with the actual SHA-256 of the mcp-logger tarball you're pointing to (see "Computing sha256" below).
5. Commit and push.

The manager fetches from:
`https://raw.githubusercontent.com/pinta-ai/pinta-catalog/main/catalog/index.json`

## Computing sha256

```bash
curl -L -o /tmp/mcp-logger.tgz https://registry.npmjs.org/@awarecorp/mcp-logger/-/mcp-logger-<version>.tgz
shasum -a 256 /tmp/mcp-logger.tgz
```

## Local dev — point manager to a local catalog

```bash
PINTA_CATALOG_URL=file:///path/to/pinta-catalog-seed/catalog/index.json npm run tauri:dev
```

## Manager compatibility & releases

Old (not-yet-upgraded) managers keep reading the latest catalog, so the catalog
must stay backward-compatible. Before adding `minimumRequiredManagerVersion`
fields, bumping `schema_version`, pruning manifests, or tagging a manager
release, read **[`docs/manager-compat.md`](docs/manager-compat.md)** — it
describes the compatibility contract and the publishing discipline that keeps
shipped managers working. Tag a manager release line with
`scripts/tag-manager-release.sh <X.Y.Z>`.
