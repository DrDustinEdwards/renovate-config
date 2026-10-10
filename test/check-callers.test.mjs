import assert from "node:assert/strict";
import test from "node:test";

import { callerProblems } from "../scripts/check-callers.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const call = (ref, extra = "") => `jobs:
  score:
    uses: DrDustinEdwards/devkit/.github/workflows/improve-score.yml@${ref}
${extra}`;

test("a call pinned to a full commit sha is accepted", () => {
  assert.deepEqual(callerProblems(call(SHA)), []);
});

test("a trailing comment naming the version does not hide the sha", () => {
  assert.deepEqual(callerProblems(call(`${SHA} # v1.2.0`)), []);
});

test("a call pinned to a branch is refused", () => {
  const problems = callerProblems(call("main"));
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /not a full 40-character commit sha/);
});

test("a call pinned to a tag is refused, because a tag can be moved", () => {
  assert.equal(callerProblems(call("v1")).length, 1);
});

test("a short sha is refused", () => {
  assert.equal(callerProblems(call(SHA.slice(0, 7))).length, 1);
});

test("an uppercase or 41-character ref is not a sha", () => {
  assert.equal(callerProblems(call(SHA.toUpperCase())).length, 1);
  assert.equal(callerProblems(call(`${SHA}0`)).length, 1);
});

test("secrets: inherit is refused", () => {
  const problems = callerProblems(call(SHA, "    secrets: inherit\n"));
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /pass IMPROVE_SCORE_KEY by name/);
});

test("a file that calls nothing is a problem, not a pass", () => {
  assert.deepEqual(callerProblems("name: x\n"), [{ line: 0, problem: "no call to a devkit reusable workflow" }]);
});

test("CRLF line endings are read the same as LF", () => {
  assert.deepEqual(callerProblems(call(SHA).replace(/\n/g, "\r\n")), []);
});
