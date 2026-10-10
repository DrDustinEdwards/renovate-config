# devkit

Shared configuration for the Dustin Edwards repositories, public so private repositories can use it.

- `default.json`: the Renovate policy (ruling 33, `dustinedwards/decisions.md`). Each repository's `renovate.json` extends it.
- `.github/workflows/improve-score.yml`: the shared improve-score workflow (D5.1). It is the `score` job that used to be copied byte for byte into five repositories, now written once. It is called, never run on its own.
- `.github/workflows/bump-consumers.yml`: the release side of the own-packages rule in `default.json`. A package repository calls it on a tag push, and it starts a Renovate run in every repository whose `package.json` depends on that package, by ticking the manual-run box on that repository's Dependency Dashboard. Consumers are found from the manifests each time, never listed. It needs the `RENOVATE_TRIGGER_TOKEN` secret described in its header.
- `.github/workflows/no-bloat.yml`: the no-bloat report (Knip and jscpd against the repository's baseline), written once for the three repositories that each wrote their own. Warn-only: it never turns a pull request red. It runs the package's `devkit-no-bloat` bin, so the caller lists the package in its devDependencies. Public repositories call it on every pull request; the four private ones weekly. See below.
- `.github/workflows/ai-author.yml`: the gate that refuses an AI attribution trailer on a commit a push or pull request adds, and on a pull request a commit authored or committed as Claude. Capsid alone had it; every repository calls it, the private ones included, since it takes seconds. It runs the package's `devkit-check-trailers` bin from the devkit tag the caller pins.
- `scripts/check-callers.mjs`: the check a caller runs on its own workflow files. Every call to this repository's workflows must pin a full 40-character commit sha, and `secrets: inherit` is refused.
- `examples/no-bloat-caller.yml` and `examples/ai-author-caller.yml`: the shape of each caller.
- `examples/improve-score-caller.yml`: the shape of a caller. The per-repository `build` job stays in the caller; only `score` is shared.
- `testing/` and `bin/`: the shared test helpers and the shared checks, the part of this repository that is a package (`@dustinedwards/devkit`). See below.
- `test/`: runs the bump-consumers script against a stub of the GitHub API, and holds the shared scorer to its isolation properties (no network and read-only mounts for attempt code, the signing key in exactly two steps and never in the container, every action pinned, the attempt branch never checked out) and the check to its pin rule, and the test helpers to the behaviour their consumers rely on. CI runs them.

## Changing the shared scorer

Only by a reviewed pull request here, and a change reaches a caller only when that caller's default branch takes a reviewed change to the sha on its `uses:` line. That is the point: an improve attempt can edit its own repository, never what measures it. Do not edit a caller's `uses:` line to a branch or a tag; `check-callers.mjs` fails on it.

## The shared test helpers

Test code that more than one repository needs, written once here so the copies stop drifting (`capsid/research/design-shared-tests.md`, D1 and D2 of job_bf31c124055e). Installed by tag, like site-api:

    "@dustinedwards/devkit": "github:DrDustinEdwards/devkit#v0.4.0"

Only `testing/`, `bin/` and this README are in the package. No dependencies and no test framework: they run in node and in workerd.

- `@dustinedwards/devkit/github`: `stubGitHub({ owner, repo, branch, files })`, a fake of the GitHub contents and Git Data API at the outbound fetch. An unknown host or route throws, blob shas are real, a tree applies only when the ref moves, `failNext` plants 500s and `history` plants the commit listing. `install: false` hands back the fake as `fetch` instead of installing it globally. `gitBlobSha` and `versionOf` come with it.
- `@dustinedwards/devkit/network`: `refuseNetwork({ hint })`, the global fetch that throws naming the URL, and `installFetch`, the swap under it and under the GitHub fake. Each returns its restore.

- `@dustinedwards/devkit/d1`: `resetDb(db, { keep })`, which empties every table `sqlite_master` lists in one batch, so a table a migration adds is cleared without anyone adding it to a list. A full-text table is cleared through itself and its shadow tables are left to it; foreign keys are checked at commit, so table order does not matter; `d1_migrations`, SQLite's and D1's own tables are never touched. It returns the tables it cleared.

An entry point is added when a repository adopts it, so each one ships with a consumer: `/access` comes with capsid. `/clock` waits until a repository needs it. A release is a tag; a consumer moves to it in its own pull request.

## The shared checks

Checks more than one repository runs in CI, as bins in the same package (D3 and D4 of job_bf31c124055e), so a check runs the same on a laptop as in the shared workflow that calls it.

- `devkit-no-bloat`: Knip and jscpd, each count compared with the baseline in the repository's `.no-bloat.json`, and what grew said as a `::warning::` line and a table in the job summary. It always exits 0: a number nobody has acted on is information, not a rule. A tool the repository installs runs from `node_modules/.bin`, any other through npx at the major in the config's `tools` (default `knip@6`, `jscpd@4`). `npx devkit-no-bloat --write-baseline` records the current counts. The config's fields are in the header of `bin/no-bloat.mjs`; capsid's `scripts/no-bloat-baseline.json` is already in the baseline's shape.
- `devkit-check-trailers`: capsid's `check-commit-trailers.mjs`, the same rules and exits. With no arguments it reads the range from the GitHub event (`EVENT`, `PR_BASE`, `PR_HEAD`, `PUSH_BEFORE`, `PUSH_AFTER`, set by `ai-author.yml`); locally, `npx devkit-check-trailers <base> <head> [--authors]`. Exit 1 names each commit and how to fix it; exit 2 means it could not read the commits, which is a failure, not a pass.

Per-repository measurements (capsomer's page weight, dustinedwards-info's route weight) stay in the repository, as a job beside the shared one.
