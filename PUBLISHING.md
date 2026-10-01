# Isolated SKAX staging catalog

This catalog line is served from the `staging/skax-a` branch and requires
Manager `0.1.16` or an RC on that release line. Select that branch explicitly
through the Stage Manager's existing Catalog Branch setting.

The line starts independently so it contains only the selected `-skax.0`
manifests. Manager deliberately prefers stable manifests whenever one is
eligible; merely adding prereleases beside the production manifests would
not install these builds. No production manifest or its history is removed.

Do not merge this line into `main`, point production clients at it, or move
any `manager-v*` fallback tag to it. Defaults and shared production pointers
remain unchanged. Older floor-blind clients are not supported on this
explicitly selected staging line.

Use the unchanged catalog tools:

```sh
bun run catalog:build
bun run catalog:check
bun run catalog:verify-artifacts
```

The generated index and published manifests remain immutable under the
normal history checks. The first PR uses the supported empty-base bootstrap
case; subsequent PRs must preserve all healthy versions already published
on this staging line. Publishing this catalog does not change native-host
enforcement limitations or establish customer acceptance.
