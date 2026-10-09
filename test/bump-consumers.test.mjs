// Runs the script of bump-consumers.yml exactly as actions/github-script runs it (an async function of github, context,
// core and process), against a stub of the GitHub API, so the consumer rule and the checkbox edit are tested as they ship.
// Text based on purpose, like workflow-policy.test.mjs: the workflow is read as the runner reads it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const FILE = new URL("../.github/workflows/bump-consumers.yml", import.meta.url);
const text = readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
const code = (/** @type {string} */ s) => s.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

/** The `script: |` block, dedented, as github-script receives it. */
const script = (() => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s+script: \|$/.test(line));
  assert.ok(start > 0, "a script: | block");
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !line.startsWith("            ")) break;
    body.push(line.slice(12));
  }
  return body.join("\n");
})();

const b64 = (/** @type {unknown} */ value) => ({ content: Buffer.from(JSON.stringify(value)).toString("base64") });
const UNTICKED = "intro\n\n- [ ] <!-- manual job -->Check this box to trigger a request for Renovate to run again on this repository\n";

/** A stub account: repos by name, each with files and issues. */
function stub(/** @type {Record<string, { files?: Record<string, unknown>, issues?: any[], archived?: boolean, unreadable?: boolean }>} */ repos) {
  const updates = [];
  const api = {
    rest: {
      repos: {
        listForAuthenticatedUser: Symbol("repos"),
        getContent: async ({ repo, path }) => {
          const value = repos[repo]?.files?.[path];
          if (value === undefined) throw new Error("Not Found");
          return { data: b64(value) };
        },
      },
      git: {
        getTree: async ({ repo }) => {
          if (repos[repo].unreadable) throw new Error("Bad credentials");
          return { data: { tree: Object.keys(repos[repo].files ?? {}).map((path) => ({ path, type: "blob" })) } };
        },
      },
      issues: {
        listForRepo: Symbol("issues"),
        update: async (args) => updates.push(args),
      },
    },
    paginate: async (method, args) => {
      if (method === api.rest.repos.listForAuthenticatedUser) {
        return Object.entries(repos).map(([name, r]) => ({ name, archived: Boolean(r.archived), default_branch: "main", owner: { login: "DrDustinEdwards" } }));
      }
      return (repos[args.repo].issues ?? []).filter((issue) => issue.user === args.creator);
    },
  };
  return { api, updates };
}

async function run(repos, { self = "capsomer", dryRun = false } = {}) {
  const { api, updates } = stub(repos);
  const log = { warnings: [], errors: [], failed: null, info: [] };
  const summary = { addHeading: () => summary, addTable: () => summary, write: async () => summary };
  const core = {
    warning: (m) => log.warnings.push(m),
    error: (m) => log.errors.push(m),
    info: (m) => log.info.push(m),
    setFailed: (m) => (log.failed = m),
    summary,
  };
  const context = { repo: { owner: "DrDustinEdwards", repo: self }, sha: "0".repeat(40) };
  const proc = { env: { DRY_RUN: String(dryRun) } };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction("github", "context", "core", "process", script)(api, context, core, proc);
  return { updates, log };
}

const dashboard = (number = 7) => ({ number, title: "Dependency Dashboard", user: "renovate[bot]", body: UNTICKED });

test("a consumer by github: reference, at any depth, gets its manual-run box ticked and nothing else changes", async () => {
  const { updates, log } = await run({
    capsomer: { files: { "package.json": { name: "capsomer" } } },
    capsid: { files: { "package.json": {}, "dashboard/package.json": { dependencies: { capsomer: "github:DrDustinEdwards/capsomer#v0.5.0" } } }, issues: [dashboard(4)] },
    bystander: { files: { "package.json": { dependencies: { zod: "4.0.0" } } }, issues: [dashboard(1)] },
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].repo, "capsid");
  assert.equal(updates[0].issue_number, 4);
  assert.equal(updates[0].body, UNTICKED.replace("- [ ] <!-- manual job -->", "- [x] <!-- manual job -->"));
  assert.equal(log.failed, null);
});

test("git+https and sha pins count, and so does the npm name for a package that is also on npm", async () => {
  const { updates } = await run(
    {
      enarratio: { files: { "package.json": { name: "enarratio" } } },
      capsomer: { files: { "package.json": { devDependencies: { enarratio: "git+https://github.com/DrDustinEdwards/enarratio.git#f419f16526ea1a0a51d1f7364262e50b1a57baf9" } } }, issues: [dashboard(2)] },
      site: { files: { "package.json": { dependencies: { enarratio: "0.1.0-alpha.8" } } }, issues: [dashboard(18)] },
      lookalike: { files: { "package.json": { dependencies: { enarratio: "github:someoneelse/enarratio#v1.0.0", x: "github:DrDustinEdwards/enarratio-extra#v1" } } }, issues: [dashboard(3)] },
    },
    { self: "enarratio" },
  );
  assert.deepEqual(updates.map((u) => u.repo).sort(), ["capsomer", "site"]);
});

test("an aliased dependency is found by its reference, not its name", async () => {
  const { updates } = await run(
    {
      "site-runtime": { files: { "package.json": { name: "@dustinedwards/site-runtime" } } },
      site: { files: { "package.json": { dependencies: { "@dustinedwards/security-headers": "github:DrDustinEdwards/site-runtime#v0.1.1" } } }, issues: [dashboard()] },
    },
    { self: "site-runtime" },
  );
  assert.deepEqual(updates.map((u) => u.repo), ["site"]);
});

test("a dry run ticks nothing", async () => {
  const { updates, log } = await run(
    { capsomer: { files: { "package.json": { name: "capsomer" } } }, site: { files: { "package.json": { dependencies: { capsomer: "github:DrDustinEdwards/capsomer#v0.4.0" } } }, issues: [dashboard()] } },
    { dryRun: true },
  );
  assert.equal(updates.length, 0);
  assert.ok(log.info.some((line) => line.includes("would tick #7")));
});

test("a consumer without Renovate is a warning naming it, and archived repositories and node_modules are skipped", async () => {
  const { updates, log } = await run({
    capsomer: { files: { "package.json": { name: "capsomer" } } },
    txasm: { files: { "package.json": { dependencies: { capsomer: "github:DrDustinEdwards/capsomer#v0.4.0" } } } },
    old: { archived: true, files: { "package.json": { dependencies: { capsomer: "github:DrDustinEdwards/capsomer#v0.1.0" } } }, issues: [dashboard()] },
    vendored: { files: { "node_modules/x/package.json": { dependencies: { capsomer: "github:DrDustinEdwards/capsomer#v0.1.0" } } }, issues: [dashboard()] },
    ticked: { files: { "package.json": { dependencies: { capsomer: "github:DrDustinEdwards/capsomer#v0.5.0" } } }, issues: [{ ...dashboard(), body: "- [x] <!-- manual job -->x" }] },
    impostor: { files: { "package.json": { dependencies: { capsomer: "github:DrDustinEdwards/capsomer#v0.5.0" } } }, issues: [{ ...dashboard(), user: "someone" }] },
  });
  assert.equal(updates.length, 0);
  assert.ok(log.warnings.some((w) => w.startsWith("txasm:")));
  assert.ok(log.warnings.some((w) => w.startsWith("impostor:")), "only an issue opened by renovate[bot] is the dashboard");
  assert.ok(log.info.some((line) => line.startsWith("ticked") && line.includes("already requested")));
  assert.equal(log.failed, null);
});

test("a repository that cannot be read fails the run instead of passing silently", async () => {
  const { updates, log } = await run({
    capsomer: { files: { "package.json": { name: "capsomer" } } },
    broken: { unreadable: true },
    site: { files: { "package.json": { dependencies: { capsomer: "github:DrDustinEdwards/capsomer#v0.4.0" } } }, issues: [dashboard()] },
  });
  assert.deepEqual(updates.map((u) => u.repo), ["site"], "the other consumers are still triggered");
  assert.ok(log.errors.some((e) => e.startsWith("broken:")));
  assert.match(log.failed ?? "", /1 consumer/);
});

test("it is only callable, every action is pinned, it asks GITHUB_TOKEN for nothing, and the token is passed by name", () => {
  const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:"));
  assert.match(on, /workflow_call:/);
  assert.doesNotMatch(on, /workflow_dispatch|pull_request|push:|schedule:/);
  assert.match(text, /\npermissions: \{\}\n/);
  assert.doesNotMatch(code(text), /: write\b/);
  const uses = [...code(text).matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 1);
  for (const ref of uses) assert.match(ref, /@[0-9a-f]{40}$/, ref);
  assert.doesNotMatch(code(text), /secrets: inherit/);
});
