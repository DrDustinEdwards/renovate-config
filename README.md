# renovate-config

Shared configuration for the Dustin Edwards repositories, public so private repositories can use it.

- `default.json`: the Renovate policy (ruling 33, `dustinedwards/decisions.md`). Each repository's `renovate.json` extends it.
- `.github/workflows/improve-score.yml`: the shared improve-score workflow (D5.1). It is the `score` job that used to be copied byte for byte into five repositories, now written once. It is called, never run on its own.
- `.github/workflows/bump-consumers.yml`: the release side of the own-packages rule in `default.json`. A package repository calls it on a tag push, and it starts a Renovate run in every repository whose `package.json` depends on that package, by ticking the manual-run box on that repository's Dependency Dashboard. Consumers are found from the manifests each time, never listed. It needs the `RENOVATE_TRIGGER_TOKEN` secret described in its header.
- `scripts/check-callers.mjs`: the check a caller runs on its own workflow files. Every call to this repository's workflows must pin a full 40-character commit sha, and `secrets: inherit` is refused.
- `examples/improve-score-caller.yml`: the shape of a caller. The per-repository `build` job stays in the caller; only `score` is shared.
- `test/`: runs the bump-consumers script against a stub of the GitHub API, and holds the shared scorer to its isolation properties (no network and read-only mounts for attempt code, the signing key in exactly two steps and never in the container, every action pinned, the attempt branch never checked out) and the check to its pin rule. CI runs them.

## Changing the shared scorer

Only by a reviewed pull request here, and a change reaches a caller only when that caller's default branch takes a reviewed change to the sha on its `uses:` line. That is the point: an improve attempt can edit its own repository, never what measures it. Do not edit a caller's `uses:` line to a branch or a tag; `check-callers.mjs` fails on it.
