// The no-bloat bin: counts read from the tools, compared with the repository's baseline, warn-only whatever happens. The
// units run against a fake runner; the end-to-end cases run the bin itself in a scratch repository whose node_modules/.bin
// holds stand-ins for knip and jscpd, so nothing is downloaded.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compare, knipCounts, measure, npxArgs, render } from "../bin/no-bloat.mjs";

const BIN = fileURLToPath(new URL("../bin/no-bloat.mjs", import.meta.url));

const KNIP = "Unused files (2)\nsrc/a.ts\nsrc/b.ts\nUnused exports (3)\nsrc/c.ts: x, y, z\n";

/** A runner that answers knip with `knip` and writes a jscpd report with `clones` into the --output directory. */
const fakeRun = ({ knip = KNIP, clones = 4, percentage = 1.234 } = {}) => {
  /** @type {Array<[string, string[]]>} */
  const calls = [];
  /** @type {import("../bin/no-bloat.mjs").Runner} */
  const run = (name, args) => {
    calls.push([name, args]);
    if (name === "knip") return knip;
    const out = args[args.indexOf("--output") + 1];
    writeFileSync(join(out, "jscpd-report.json"), JSON.stringify({ statistics: { total: { clones, percentage } } }));
    return "";
  };
  return { run, calls };
};

test("a tool that is not installed is named to npx with --package, so an inherited npm_config_package cannot replace it", () => {
  assert.deepEqual(npxArgs("knip", "knip@6", ["--no-progress"]), ["--yes", "--package", "knip@6", "--", "knip", "--no-progress"]);
});

test("knipCounts reads the compact report's headings", () => {
  assert.deepEqual(knipCounts(KNIP), { "Unused files": 2, "Unused exports": 3 });
  assert.deepEqual(knipCounts("✂️  Excellent, Knip found no issues.\n"), {});
});

test("with no config: one knip run, jscpd on the root unless the repository has its own .jscpd.json", () => {
  const bare = fakeRun();
  assert.deepEqual(measure({}, bare.run, false).counts, { knip: { "Unused files": 2, "Unused exports": 3 }, jscpd: { clones: 4, percentage: 1.23 } });
  assert.deepEqual(bare.calls[0], ["knip", ["--no-exit-code", "--no-progress", "--reporter", "compact"]]);
  assert.equal(bare.calls[1][1][0], ".");

  const configured = fakeRun();
  measure({}, configured.run, true);
  assert.equal(configured.calls[1][1][0], "--reporters");
});

test("each knip run is labelled and passes its own arguments; jscpd's arguments come before the report flags", () => {
  const { run, calls } = fakeRun();
  const { counts } = measure(
    { knip: [{ label: "knip (Worker)" }, { label: "knip (dashboard)", args: ["--directory", "dashboard"] }], jscpd: { args: ["app", "--min-lines", "8"] } },
    run,
  );
  assert.deepEqual(Object.keys(counts), ["knip (Worker)", "knip (dashboard)", "jscpd"]);
  assert.deepEqual(calls[1][1].slice(0, 2), ["--directory", "dashboard"]);
  assert.deepEqual(calls[2][1].slice(0, 3), ["app", "--min-lines", "8"]);
});

test("jscpd: false skips it", () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(Object.keys(measure({ jscpd: false }, run).counts), ["knip"]);
  assert.equal(calls.length, 1);
});

test("a tool that cannot run is a warning naming its error, and the others still run", () => {
  const { counts, warnings } = measure({}, (name) => {
    if (name === "knip") throw new Error("knip exited 2: no package.json");
    throw new Error("jscpd exited 1");
  });
  assert.deepEqual(counts, {});
  assert.deepEqual(warnings, ["knip could not run: knip exited 2: no package.json", "jscpd could not run: jscpd exited 1"]);
});

test("what grew is a warning; what shrank or held is not; a finding new to a known tool counts from zero", () => {
  const { rows, warnings } = compare(
    { measured_at: "abc1234", "knip (dashboard)": { "Unused exports": 5, "Unused files": 1 }, jscpd: { clones: 4, percentage: 1.5 } },
    { "knip (dashboard)": { "Unused exports": 6, "Unused types": 1 }, jscpd: { clones: 3, percentage: 1.2 } },
    [{ label: "knip (dashboard)", args: ["--directory", "dashboard"] }],
  );
  assert.deepEqual(rows, [
    ["knip (dashboard)", "Unused exports", 5, 6],
    ["knip (dashboard)", "Unused files", 1, 0],
    ["knip (dashboard)", "Unused types", 0, 1],
    ["jscpd", "clones", 4, 3],
    ["jscpd", "duplicated lines %", 1.5, 1.2],
  ]);
  assert.deepEqual(warnings, [
    "knip (dashboard): Unused exports went from 5 to 6. Run `npx knip --directory dashboard` to see which.",
    "knip (dashboard): Unused types went from 0 to 1. Run `npx knip --directory dashboard` to see which.",
  ]);
});

test("a tool with no baseline is reported and never warned about", () => {
  const { rows, warnings } = compare({}, { knip: { "Unused files": 9 }, jscpd: { clones: 50, percentage: 3 } });
  assert.deepEqual(rows, [
    ["knip", "Unused files", null, 9],
    ["jscpd", "clones", null, 50],
    ["jscpd", "duplicated lines %", null, 3],
  ]);
  assert.deepEqual(warnings, []);
});

test("a clean knip run is still a row", () => {
  assert.deepEqual(compare({ knip: {} }, { knip: {} }).rows, [["knip", "findings", 0, 0]]);
  assert.deepEqual(compare({}, { knip: {} }).rows, [["knip", "findings", null, 0]]);
});

test("jscpd clones that grew are a warning", () => {
  const { warnings } = compare({ jscpd: { clones: 23, percentage: 0.59 } }, { jscpd: { clones: 25, percentage: 0.61 } });
  assert.deepEqual(warnings, ["jscpd: clones went from 23 to 25 (0.61% of lines, baseline 0.59%). Run `npx jscpd` to see them."]);
});

test("the table marks what went up and says when there is no baseline", () => {
  const table = render([["knip", "Unused files", 1, 2], ["jscpd", "clones", null, 3]], ["grew"], undefined);
  assert.match(table, /no baseline yet: run `npx devkit-no-bloat --write-baseline`/);
  assert.match(table, /\| knip \| Unused files \| 1 \| 2 \(up\) \|/);
  assert.match(table, /\| jscpd \| clones \| none \| 3 \|/);
  assert.match(table, /- grew$/);
  assert.match(render([], [], "abc1234"), /baseline abc1234\)[\s\S]*Nothing grew past the baseline\.$/);
});

/** A scratch repository with stand-in knip and jscpd in node_modules/.bin. */
function scratch({ knip = KNIP, clones = 4, jscpdFails = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "no-bloat-"));
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "knip"), `#!/bin/sh\nprintf '%s' '${knip}'\n`);
  writeFileSync(
    join(bin, "jscpd"),
    jscpdFails
      ? "#!/bin/sh\necho 'jscpd: boom' >&2\nexit 3\n"
      : `#!/bin/sh\nwhile [ "$1" != "--output" ]; do shift; done\nprintf '{"statistics":{"total":{"clones":${clones},"percentage":2.5}}}' > "$2/jscpd-report.json"\n`,
  );
  chmodSync(join(bin, "knip"), 0o755);
  chmodSync(join(bin, "jscpd"), 0o755);
  return dir;
}

const runBin = (/** @type {string} */ cwd, /** @type {string[]} */ args = [], env = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env } });

test("end to end: --write-baseline records the counts, and a later run that grew warns and still exits 0", { skip: process.platform === "win32" }, () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, ".no-bloat.json"), JSON.stringify({ knip: [{ label: "knip (root)" }] }));
    const written = runBin(dir, ["--write-baseline"]);
    assert.equal(written.status, 0, written.stderr);
    const config = JSON.parse(readFileSync(join(dir, ".no-bloat.json"), "utf8"));
    assert.deepEqual(config.knip, [{ label: "knip (root)" }]);
    assert.deepEqual(config.baseline["knip (root)"], { "Unused files": 2, "Unused exports": 3 });
    assert.deepEqual(config.baseline.jscpd, { clones: 4, percentage: 2.5 });
    assert.equal(typeof config.baseline.measured_at, "string");

    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const grown = scratch({ clones: 7 });
    writeFileSync(join(grown, ".no-bloat.json"), JSON.stringify(config));
    const r = runBin(grown, [], { GITHUB_STEP_SUMMARY: summary });
    rmSync(grown, { recursive: true, force: true });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /::warning::jscpd: clones went from 4 to 7/);
    assert.doesNotMatch(r.stdout, /::warning::knip/);
    assert.match(readFileSync(summary, "utf8"), /### No-bloat report \(warn-only; baseline /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end: a tool that fails is a warning and exit 0; --write-baseline refuses to record a partial baseline", { skip: process.platform === "win32" }, () => {
  const dir = scratch({ jscpdFails: true });
  try {
    const r = runBin(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /::warning::jscpd could not run: jscpd exited 3: jscpd: boom/);
    assert.match(r.stdout, /\| knip \| Unused files \| none \| 2 \|/);

    const w = runBin(dir, ["--write-baseline"]);
    assert.equal(w.status, 1);
    assert.match(w.stderr, /the baseline was not written/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end: a config that is not JSON is a warning, not a failure", { skip: process.platform === "win32" }, () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, ".no-bloat.json"), "{ nope");
    const r = runBin(dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /::warning::.*\.no-bloat\.json is not JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
