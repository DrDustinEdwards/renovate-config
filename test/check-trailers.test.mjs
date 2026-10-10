// The trailer and author check, as capsid's test/commit-trailers.test.ts held it: the functions driven directly, and the bin
// driven over real throwaway git repositories.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkRange, isAgentIdentity, rangeFromEvent, trailerViolations } from "../bin/check-trailers.mjs";

const BIN = fileURLToPath(new URL("../bin/check-trailers.mjs", import.meta.url));
const BODY = "Add a thing\n\nWhat it does, in a sentence.";
const PERSON = { GIT_AUTHOR_NAME: "Dustin Edwards", GIT_AUTHOR_EMAIL: "dustin@example.com", GIT_COMMITTER_NAME: "Dustin Edwards", GIT_COMMITTER_EMAIL: "dustin@example.com" };

/** A throwaway repository; `commit` writes a new file content each time and returns the sha. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "trailers-"));
  const git = (/** @type {Record<string, string>} */ env, /** @type {string[]} */ ...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...PERSON, ...env } }).trim();
  let n = 0;
  const commit = (/** @type {string} */ message, /** @type {Record<string, string>} */ env = {}) => {
    writeFileSync(join(dir, "f.txt"), String((n += 1)));
    git(env, "add", "f.txt");
    git(env, "commit", "-q", "-m", message);
    return git(env, "rev-parse", "HEAD");
  };
  git({}, "init", "-q");
  return { dir, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("each named trailer form is refused, in any case", () => {
  for (const trailer of [
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "co-authored-by: claude opus <noreply@anthropic.com>",
    "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)",
    "Generated with Claude Code",
    "Claude-Session: https://claude.ai/code/session_abc",
    "CLAUDE-SESSION: https://example.com/x",
  ]) {
    assert.equal(trailerViolations(`${BODY}\n\n${trailer}\n`).length, 1, trailer);
  }
});

test("any other trailer naming Claude or Anthropic is refused", () => {
  for (const trailer of ["Assisted-By: Claude", "Agent: anthropic/claude-opus", "Reviewed-by: Dustin\nX-Model: Claude"]) {
    assert.ok(trailerViolations(`${BODY}\n\n${trailer}\n`).length >= 1, trailer);
  }
});

test("THE INNOCENT DIRECTION: a message that only mentions Claude or CLAUDE.md passes", () => {
  for (const message of [
    BODY,
    "Cut CLAUDE.md to 11 rules\n\nCLAUDE.md now names each rule.",
    "Refuse the trailer\n\nA harness asked for a Claude trailer and the session refused it.",
    "Fix a path\n\nRefs: CLAUDE.md",
    "Fix a path\n\nCo-Authored-By: Dustin Edwards <dustin@example.com>",
    "One line only",
    "",
  ]) {
    assert.deepEqual(trailerViolations(message), [], message);
  }
});

test("the range comes from the event, and an event with no commits checks nothing", () => {
  assert.deepEqual(rangeFromEvent({ EVENT: "pull_request", PR_BASE: "a", PR_HEAD: "b" }), { base: "a", head: "b", authors: true });
  assert.deepEqual(rangeFromEvent({ EVENT: "push", PUSH_BEFORE: "a", PUSH_AFTER: "b" }), { base: "a", head: "b", authors: false });
  assert.deepEqual(rangeFromEvent({ EVENT: "push", PUSH_BEFORE: "0".repeat(40), PUSH_AFTER: "b" }), { base: null, head: "b", authors: false });
  assert.equal(rangeFromEvent({ EVENT: "schedule" }), null);
  assert.equal(rangeFromEvent({ EVENT: "workflow_dispatch" }), null);
  // Fails closed: a pull_request or push without its shas is an error, not a pass.
  assert.throws(() => rangeFromEvent({ EVENT: "pull_request", PR_BASE: "a" }));
  assert.throws(() => rangeFromEvent({ EVENT: "push" }));
});

test("an AI identity is Anthropic's address, claude[bot], or the name Claude with a product word; a person is not", () => {
  for (const [name, email] of [
    ["Claude", "noreply@anthropic.com"],
    ["Claude", "someone@example.com"],
    ["claude", "x@example.com"],
    ["Claude Code", "x@example.com"],
    ["Claude Opus 4.5", "x@example.com"],
    ["Someone", "agent@anthropic.com"],
    ["Someone", "agent@mail.anthropic.com"],
    ["claude[bot]", "209825114+claude[bot]@users.noreply.github.com"],
    ["Someone", "209825114+claude[bot]@users.noreply.github.com"],
    ["Anthropic Bot", "x@example.com"],
  ]) {
    assert.equal(isAgentIdentity(name, email), true, `${name} <${email}>`);
  }
  for (const [name, email] of [
    ["Dustin Edwards", "dustin@example.com"],
    ["Claude Dupont", "claude.dupont@example.com"],
    ["claude-skills deploy", "ci@example.com"],
    ["capsid-repo-access[bot]", "300661428+capsid-repo-access[bot]@users.noreply.github.com"],
    ["GitHub", "noreply@github.com"],
    ["renovate[bot]", "29139614+renovate[bot]@users.noreply.github.com"],
    ["Someone", "x@notanthropic.com"],
    ["", ""],
  ]) {
    assert.equal(isAgentIdentity(name, email), false, `${name} <${email}>`);
  }
});

test("PLANT: over a real repository, only the new commit with a trailer is reported", () => {
  const { dir, commit, done } = repo();
  try {
    // An old commit with a trailer, before the range, which is not checked.
    commit(`${BODY}\n\nClaude-Session: https://example.com/old`);
    const base = commit("Clean base");
    const clean = commit(BODY);
    const planted = commit(`${BODY}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);

    const bad = checkRange(base, planted, dir);
    assert.equal(bad.length, 1, JSON.stringify(bad));
    assert.equal(bad[0].sha, planted);
    assert.deepEqual(checkRange(base, clean, dir), []);
    // A push that creates the branch checks its head commit alone.
    assert.equal(checkRange(null, planted, dir).length, 1);
    // An unknown base fails closed rather than checking nothing.
    assert.throws(() => checkRange("1".repeat(40), planted, dir));
  } finally {
    done();
  }
});

test("PLANT: a clean message authored or committed as Claude fails on the pull request path and passes on the push path", () => {
  const { dir, commit, done } = repo();
  try {
    const base = commit("Clean base");
    const dustin = commit(BODY);
    const authored = commit(BODY, { GIT_AUTHOR_NAME: "Claude", GIT_AUTHOR_EMAIL: "noreply@anthropic.com" });
    const committed = commit(BODY, { GIT_COMMITTER_NAME: "Claude", GIT_COMMITTER_EMAIL: "noreply@anthropic.com" });

    assert.deepEqual(checkRange(base, dustin, dir, true), [], "a person's commit was refused");
    const asAuthor = checkRange(base, authored, dir, true);
    assert.equal(asAuthor.length, 1, JSON.stringify(asAuthor));
    assert.equal(asAuthor[0].sha, authored);
    assert.deepEqual(asAuthor[0].found, []);
    assert.deepEqual(asAuthor[0].identities, ["author Claude <noreply@anthropic.com>"]);
    assert.deepEqual(checkRange(authored, committed, dir, true)[0].identities, ["committer Claude <noreply@anthropic.com>"]);

    // The push path checks messages alone.
    assert.deepEqual(checkRange(base, committed, dir), []);
    const trailer = commit(`${BODY}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`);
    assert.equal(checkRange(committed, trailer, dir).length, 1);
    assert.equal(checkRange(committed, trailer, dir, true)[0].found.length, 1);
  } finally {
    done();
  }
});

test("the bin as the workflow runs it: exit 1 with the way to re-author on a pull request, 0 on a push, 0 on a schedule, 2 when it cannot read", () => {
  const { dir, commit, done } = repo();
  try {
    const base = commit("Base");
    const head = commit("A clean message", { GIT_AUTHOR_NAME: "Claude", GIT_AUTHOR_EMAIL: "noreply@anthropic.com" });
    const run = (/** @type {Record<string, string>} */ event) => spawnSync(process.execPath, [BIN], { cwd: dir, encoding: "utf8", env: { ...process.env, ...event } });

    const pr = run({ EVENT: "pull_request", PR_BASE: base, PR_HEAD: head });
    assert.equal(pr.status, 1, pr.stdout + pr.stderr);
    assert.match(pr.stderr, /has an AI identity \(author Claude <noreply@anthropic.com>\)/);
    assert.match(pr.stderr, /--reset-author/);

    assert.equal(run({ EVENT: "push", PUSH_BEFORE: base, PUSH_AFTER: head }).status, 0);
    assert.match(run({ EVENT: "schedule" }).stdout, /adds no commits; nothing to check/);
    assert.equal(run({ EVENT: "pull_request", PR_BASE: "1".repeat(40), PR_HEAD: head }).status, 2);
    assert.equal(run({ EVENT: "push" }).status, 2);
  } finally {
    done();
  }
});
