// Holds the shared no-bloat workflow to what makes it safe to call from every repository: only callable, read-only, no
// secrets, every action pinned, and never able to turn a caller's pull request red. Text based, as workflow-policy is.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { callerProblems } from "../scripts/check-callers.mjs";

const text = readFileSync(new URL("../.github/workflows/no-bloat.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const code = text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
const steps = text
  .slice(text.indexOf("    steps:\n") + "    steps:\n".length)
  .split(/\n(?=      - )/)
  .map((step) => step.trimEnd());

test("it is only callable", () => {
  const on = text.slice(text.indexOf("\non:\n"), text.indexOf("\npermissions:"));
  assert.match(on, /workflow_call:/);
  assert.doesNotMatch(on, /workflow_dispatch|pull_request|push:|schedule:/);
});

test("the token is read-only and no secret is taken or read", () => {
  assert.match(text, /\npermissions:\n {2}contents: read\n/);
  assert.doesNotMatch(code, /: write\b/);
  assert.doesNotMatch(code, /secrets/);
});

test("every action is pinned to a full commit sha, and the checkout keeps no credentials", () => {
  const uses = [...code.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const ref of uses) assert.match(ref, /@[0-9a-f]{40}$/, ref);
  assert.match(steps.find((s) => s.includes("actions/checkout@")) ?? "", /persist-credentials: false/);
});

test("warn-only: the job and every step after the checkout continue on error", () => {
  assert.match(text, /\n {4}continue-on-error: true\n/);
  for (const s of steps.slice(1)) assert.match(s, /continue-on-error: true/, s.split("\n")[0]);
});

test("caller input reaches a shell only through the environment, never spliced into the script", () => {
  for (const s of steps.filter((entry) => /\brun:/.test(entry))) {
    const run = s.slice(s.indexOf("run:"));
    assert.doesNotMatch(run, /\$\{\{/, s.split("\n")[0]);
  }
});

test("it runs the package's bin, which the package ships", () => {
  assert.match(text, /node_modules\/@dustinedwards\/devkit\/bin\/no-bloat\.mjs/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.bin["devkit-no-bloat"], "./bin/no-bloat.mjs");
  assert.ok(pkg.files.includes("bin"));
});

test("the example caller passes the pin check", () => {
  assert.deepEqual(callerProblems(readFileSync(new URL("../examples/no-bloat-caller.yml", import.meta.url), "utf8")), []);
});
