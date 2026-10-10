import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { gitBlobSha, stubGitHub, versionOf } from "@dustinedwards/devkit/github";

const API = "https://api.github.com/repos/Owner/site";
const post = (path, body) => fetch(`${API}${path}`, { method: "POST", body: JSON.stringify(body) });

/** A commit the way a caller makes one: blobs, a tree, a commit, then the ref moves. */
async function commit(changes, { moveRef = true, branch = "main" } = {}) {
  const tree = [];
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) tree.push({ path, sha: null });
    else tree.push({ path, sha: (await (await post("/git/blobs", { content })).json()).sha });
  }
  await post("/git/trees", { tree });
  const { sha } = await (await post("/git/commits", {})).json();
  if (moveRef) await fetch(`${API}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha }) });
}

test("gitBlobSha is the sha git itself gives, counting UTF-8 bytes", async () => {
  for (const content of ["", "hello\n", "naïve – café ✓\n"]) {
    const expected = execFileSync("git", ["hash-object", "--stdin"], { input: content }).toString().trim();
    assert.equal(await gitBlobSha(content), expected, JSON.stringify(content));
  }
});

test("a file reads back as base64 with its real blob sha; a directory as an array; a missing path 404s", async (t) => {
  const gh = stubGitHub({ owner: "Owner", repo: "site", files: { "content/a.md": "é\n", "content/b.md": "b" } });
  t.after(gh.restore);

  const file = await (await fetch(`${API}/contents/content/a.md?ref=main`)).json();
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))), "é\n");
  assert.equal(file.sha, await gitBlobSha("é\n"));
  assert.equal(file.size, 3);

  const dir = await (await fetch(`${API}/contents/content`)).json();
  assert.deepEqual(dir.map((e) => e.name), ["a.md", "b.md"]);

  assert.equal((await fetch(`${API}/contents/nope.md`)).status, 404);
  assert.equal(await versionOf(gh, "content/b.md"), await gitBlobSha("b"));
});

test("a commit applies only when the ref moves", async (t) => {
  const gh = stubGitHub({ owner: "Owner", repo: "site", files: { "a.md": "old", "gone.md": "x" } });
  t.after(gh.restore);

  await commit({ "a.md": "refused" }, { moveRef: false });
  assert.equal(gh.files.get("a.md"), "old");

  await commit({ "a.md": "new", "gone.md": null });
  assert.equal(gh.files.get("a.md"), "new");
  assert.equal(gh.files.has("gone.md"), false);
  const ref = await (await fetch(`${API}/git/ref/heads/main`)).json();
  assert.match(ref.object.sha, /^commit/);
  assert.deepEqual(gh.calls.map((c) => c.method).slice(-5), ["POST", "POST", "POST", "PATCH", "GET"]);
});

test("a tree that names a blob nobody posted throws", async (t) => {
  const gh = stubGitHub({ owner: "Owner", repo: "site" });
  t.after(gh.restore);
  await assert.rejects(post("/git/trees", { tree: [{ path: "a.md", sha: "f".repeat(40) }] }), /no recorded blob POST/);
});

test("another host, another repository, another branch and an unrecorded route all throw", async (t) => {
  const gh = stubGitHub({ owner: "Owner", repo: "site", branch: "trunk" });
  t.after(gh.restore);
  await assert.rejects(fetch("https://example.test/"), /refuses https:\/\/example\.test\//);
  await assert.rejects(fetch("https://api.github.com/repos/Owner/other/git/ref/heads/trunk"), /no recorded shape/);
  await assert.rejects(fetch(`${API}/git/ref/heads/main`), /no recorded shape for GET/);
  assert.equal((await fetch(`${API}/git/ref/heads/trunk`)).status, 200);
  await assert.rejects(fetch(`${API}/pulls`, { method: "POST" }), /no recorded shape for POST/);
});

test("failNext plants 500s on matching paths, then the route answers again", async (t) => {
  const gh = stubGitHub({ owner: "Owner", repo: "site", files: { "a.md": "a" } });
  t.after(gh.restore);
  gh.failNext("/contents/", 2);
  assert.equal((await fetch(`${API}/contents/a.md`)).status, 500);
  assert.equal((await fetch(`${API}/git/ref/heads/main`)).status, 200);
  assert.equal((await fetch(`${API}/contents/a.md`)).status, 500);
  assert.equal((await fetch(`${API}/contents/a.md`)).status, 200);
});

test("the commit listing fails until history is planted, then answers it", async (t) => {
  const gh = stubGitHub({ owner: "Owner", repo: "site" });
  t.after(gh.restore);
  assert.equal((await fetch(`${API}/commits?path=a.md`)).status, 500);
  gh.history.push({ sha: "s1", message: "m", author: "A", date: "2026-10-01T00:00:00Z" });
  const listed = await (await fetch(`${API}/commits?path=a.md`)).json();
  assert.deepEqual(listed, [{ sha: "s1", commit: { message: "m", author: { name: "A", date: "2026-10-01T00:00:00Z" } } }]);
});

test("install: false leaves the global alone and hands back the fake", async () => {
  const real = globalThis.fetch;
  const gh = stubGitHub({ owner: "Owner", repo: "site", files: { "a.md": "a" }, install: false });
  assert.equal(globalThis.fetch, real);
  assert.equal((await gh.fetch(`${API}/contents/a.md`)).status, 200);
  gh.restore();
  assert.equal(globalThis.fetch, real);
});

test("restore puts back the fetch it replaced, and the fake needs to know which repository it is", () => {
  const real = globalThis.fetch;
  stubGitHub({ owner: "Owner", repo: "site" }).restore();
  assert.equal(globalThis.fetch, real);
  assert.throws(() => stubGitHub({ owner: "Owner" }), /needs the owner and repo/);
});
