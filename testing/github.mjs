// A fake of the GitHub API for code that reads and commits files through it. Stubbed at the outbound fetch, not the
// module, because the module calling GitHub is the subject. Taken from dustinedwards-info's test/worker/github-stub.ts
// (design-shared-tests.md, section 1), with the owner, repository and branch as parameters.
//
// An unknown host or path THROWS, so nothing can fall through to the live repository. Blob shas are REAL git blob
// shas, or a provenance check that compares them could not fail. A tree applies only when the ref moves, so a refused
// save leaves the repository unchanged.

import { installFetch, urlOf } from "./network.mjs";

const API = "https://api.github.com";
const STUB_HEAD_SHA = "a".repeat(40);
const encoder = new TextEncoder();

/**
 * The sha git gives `content` as a blob: SHA-1 over `blob <byte length>\0` and the bytes. The header counts UTF-8
 * BYTES, not string length.
 *
 * @param {string} content
 * @returns {Promise<string>} lowercase hex
 */
export async function gitBlobSha(content) {
  const body = encoder.encode(content);
  const header = encoder.encode(`blob ${body.byteLength}\0`);
  const framed = new Uint8Array(header.byteLength + body.byteLength);
  framed.set(header, 0);
  framed.set(body, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", framed));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @typedef {{ method: string, path: string, body: unknown }} RecordedCall
 * @typedef {{ sha: string, message: string, author: string, date: string }} HistoryEntry
 */

/**
 * Stands up the fake for one repository. By default it is installed as the global fetch; `install: false` leaves the
 * global alone and the caller passes `fetch` to the code under test.
 *
 * @param {{ owner: string, repo: string, branch?: string, files?: Record<string, string>, install?: boolean }} options
 */
export function stubGitHub({ owner, repo, branch = "main", files: seed = {}, install = true }) {
  if (!owner || !repo) throw new Error("stubGitHub needs the owner and repo it stands in for.");
  const prefix = `/repos/${owner}/${repo}`;

  /** @type {Map<string, string>} */
  const files = new Map(Object.entries(seed));
  /** @type {RecordedCall[]} */
  const calls = [];
  /** @type {HistoryEntry[]} */
  const history = [];
  const head = { commitSha: STUB_HEAD_SHA, treeSha: "tree-initial" };
  /** @type {Map<string, number>} */
  const failures = new Map();
  /** @type {Map<string, string>} */
  const blobBodies = new Map();
  /** @type {Array<{ path: string, content: string | null }>} */
  let pendingTree = [];
  let commitCounter = 0;

  const json = (/** @type {unknown} */ body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /**
   * Each recorded endpoint: `path` is matched exactly, or as a prefix when `prefix` is set.
   *
   * @type {Array<{ method: string, path: string, prefix?: boolean, handle: (path: string, body: unknown) => Response | Promise<Response> }>}
   */
  const routes = [
    { method: "GET", path: `${prefix}/git/ref/heads/${branch}`, handle: () => json({ object: { sha: head.commitSha } }) },
    { method: "GET", path: `${prefix}/git/commits/`, prefix: true, handle: () => json({ tree: { sha: head.treeSha } }) },
    { method: "GET", path: `${prefix}/contents/`, prefix: true, handle: getContents },
    {
      method: "GET",
      path: `${prefix}/commits?`,
      prefix: true,
      // With no history planted the listing fails, so a case that reads history has to say what it is.
      handle: () =>
        history.length === 0
          ? json({ message: "no history planted" }, 500)
          : json(history.map((c) => ({ sha: c.sha, commit: { message: c.message, author: { name: c.author, date: c.date } } }))),
    },
    { method: "POST", path: `${prefix}/git/blobs`, handle: postBlob },
    { method: "POST", path: `${prefix}/git/trees`, handle: postTree },
    {
      method: "POST",
      path: `${prefix}/git/commits`,
      handle: () => json({ sha: `commit${String(commitCounter).padStart(34, "0")}` }),
    },
    { method: "PATCH", path: `${prefix}/git/refs/heads/${branch}`, handle: patchRef },
  ];

  /** @param {string} path */
  async function getContents(path) {
    const target = decodeURI(path.slice(`${prefix}/contents/`.length).split("?")[0] ?? "");

    // A directory answers with an ARRAY and a file with an OBJECT, as GitHub does.
    const children = [...files.keys()].filter((p) => p.startsWith(`${target}/`));
    if (!files.has(target) && children.length > 0) {
      return json(
        await Promise.all(
          children.map(async (p) => ({
            name: p.slice(target.length + 1),
            path: p,
            sha: await gitBlobSha(files.get(p) ?? ""),
            type: "file",
            size: (files.get(p) ?? "").length,
          })),
        ),
      );
    }

    const content = files.get(target);
    if (content === undefined) return json({ message: "Not Found" }, 404);
    const bytes = encoder.encode(content);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return json({ content: btoa(binary), encoding: "base64", sha: await gitBlobSha(content), size: bytes.byteLength });
  }

  /** @param {string} _path @param {unknown} body */
  async function postBlob(_path, body) {
    const { content } = /** @type {{ content: string }} */ (body);
    const sha = await gitBlobSha(content);
    blobBodies.set(sha, content);
    return json({ sha });
  }

  /** @param {string} _path @param {unknown} body */
  function postTree(_path, body) {
    const { tree } = /** @type {{ tree: Array<{ path: string, sha: string | null }> }} */ (body);
    pendingTree = tree.map((entry) => {
      if (entry.sha === null) return { path: entry.path, content: null };
      const content = blobBodies.get(entry.sha);
      if (content === undefined) {
        throw new Error(`the tree names blob ${entry.sha}, which no recorded blob POST created.`);
      }
      return { path: entry.path, content };
    });
    commitCounter += 1;
    return json({ sha: `tree-${commitCounter}` });
  }

  /** @param {string} _path @param {unknown} body */
  function patchRef(_path, body) {
    const { sha } = /** @type {{ sha: string }} */ (body);
    for (const entry of pendingTree) {
      if (entry.content === null) files.delete(entry.path);
      else files.set(entry.path, entry.content);
    }
    pendingTree = [];
    head.commitSha = sha;
    head.treeSha = `tree-after-${sha}`;
    return json({ object: { sha } });
  }

  /** @type {typeof fetch} */
  const stub = async (input, init) => {
    const url = urlOf(input);
    if (!url.startsWith(API)) {
      throw new Error(
        `the GitHub stub refuses ${url}: this layer never reaches the network. ` +
          `If a new outbound call is legitimate, record its shape in the stub.`,
      );
    }

    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.slice(API.length);
    const rawBody = typeof init?.body === "string" ? init.body : null;
    const body = rawBody ? JSON.parse(rawBody) : null;
    calls.push({ method, path, body });

    for (const [fragment, remaining] of failures) {
      if (remaining > 0 && path.includes(fragment)) {
        failures.set(fragment, remaining - 1);
        return json({ message: `planted failure on ${fragment}` }, 500);
      }
    }

    const route = routes.find((r) => r.method === method && (r.prefix ? path.startsWith(r.path) : path === r.path));
    if (route) return route.handle(path, body);

    throw new Error(
      `the GitHub stub has no recorded shape for ${method} ${path}. Record it rather than letting the call through.`,
    );
  };

  const restore = install ? installFetch(stub) : () => {};

  return {
    calls,
    files,
    history,
    /** Fail the next `times` requests whose path contains `fragment`, with a 500. */
    failNext: (/** @type {string} */ fragment, /** @type {number} */ times) => void failures.set(fragment, times),
    fetch: stub,
    restore,
  };
}

/**
 * The blob sha of a file as the stub holds it now: what a caller that versions files by blob sha would send back.
 *
 * @param {{ files: Map<string, string> }} stub
 * @param {string} path
 */
export const versionOf = (stub, path) => gitBlobSha(stub.files.get(path) ?? "");
