// Holds the shared scorer to the properties that make it a scorer an attempt cannot influence. Each case is a line of the
// workflow's own reasoning turned into an assertion, so a reviewed change that weakens one is a red test, not a diff someone has
// to notice. Text based on purpose: the workflow is read as the runner reads it, step by step, with no YAML library to trust.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const FILE = new URL("../.github/workflows/improve-score.yml", import.meta.url);
const text = readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");

/** The steps of the one job, each as its text, split at the `      - ` that opens a step. */
const steps = text
  .slice(text.indexOf("    steps:\n") + "    steps:\n".length)
  .split(/\n(?=      - )/)
  .map((step) => step.trimEnd());

const step = (/** @type {string} */ name) => {
  const found = steps.find((s) => s.includes(`name: ${name}`));
  assert.ok(found, `a step named "${name}"`);
  return found;
};

const code = (/** @type {string} */ s) => s.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

test("it is only callable: no push, pull_request or dispatch trigger of its own", () => {
  const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:"));
  assert.match(on, /workflow_call:/);
  assert.doesNotMatch(on, /workflow_dispatch|pull_request|push:|schedule:/);
});

test("the token is read-only", () => {
  assert.match(text, /\npermissions:\n {2}contents: read\n/);
  assert.doesNotMatch(code(text), /: write\b/);
});

test("the attempt branch is never an input and is never checked out", () => {
  assert.doesNotMatch(code(text), /inputs\.branch/);
  for (const s of steps.filter((entry) => entry.includes("actions/checkout@"))) {
    assert.doesNotMatch(code(s), /^\s+(ref|repository):/m, "checkout takes no ref or repository, so it is the caller's default branch");
    assert.match(s, /persist-credentials: false/);
  }
});

test("every action is pinned to a full commit sha", () => {
  const uses = [...code(text).matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4);
  for (const ref of uses) assert.match(ref, /@[0-9a-f]{40}$/, ref);
});

test("the signing key is read by exactly two steps and never by the container", () => {
  const holders = steps.filter((s) => code(s).includes("secrets.IMPROVE_SCORE_KEY")).map((s) => /name: (.*)/.exec(s)?.[1]);
  assert.deepEqual(holders, ["Pull the holdout suite", "Post the score report"]);
  assert.doesNotMatch(step("Run the holdout suite and recompute the secondaries in an isolated container"), /IMPROVE_SCORE_KEY|AWS_|secrets\./);
});

test("attempt code runs only in a container with no network, a read-only root and read-only mounts", () => {
  const run = step("Run the holdout suite and recompute the secondaries in an isolated container");
  assert.match(run, /--network none/);
  assert.match(run, /--read-only/);
  for (const mount of ["attempt/code:/attempt:ro", "holdout:/holdout:ro", "trusted:/trusted:ro", "GITHUB_WORKSPACE}:/repo:ro"]) {
    assert.ok(run.includes(mount), `mount ${mount}`);
  }
  assert.match(run, /node:[\w.-]+@sha256:[0-9a-f]{64}/, "the image is pinned by digest");
});

test("the trusted scorer is copied out before any attempt byte exists on the runner", () => {
  const order = steps.map((s) => /name: (.*)/.exec(s)?.[1] ?? "");
  assert.ok(order.indexOf("Stash the trusted scorer, the sandbox commands and the marker nonce") < order.indexOf("Download the attempt artifact"));
});

test("the holdout directory is wiped before the sync, so a pre-existing file cannot be counted", () => {
  const pull = step("Pull the holdout suite");
  assert.ok(pull.indexOf('rm -rf "${RUNNER_TEMP}/holdout"') !== -1);
  assert.ok(pull.indexOf('rm -rf "${RUNNER_TEMP}/holdout"') < pull.indexOf("aws s3 sync"));
});

test("an unmeasured run is reported as unmeasured, not as zero", () => {
  const count = step("Count the holdout result");
  assert.match(count, /--holdout-terminated/);
  assert.match(count, /env_failure=1/);
});

test("the namespace, run, attempt, head sha and build result come from inputs, never from the environment of the run", () => {
  const post = step("Post the score report");
  for (const input of ["namespace", "run_id", "attempt_id", "head_sha", "build_passes"]) assert.match(post + step("Pull the holdout suite"), new RegExp(`inputs\\.${input}`));
  assert.doesNotMatch(code(text), /vars\./);
  assert.doesNotMatch(code(text), /needs\./);
});
