import assert from "node:assert/strict";
import test from "node:test";

import { installFetch, refuseNetwork, urlOf } from "@dustinedwards/devkit/network";

test("urlOf reads a string, a URL and a Request", () => {
  assert.equal(urlOf("https://example.test/a"), "https://example.test/a");
  assert.equal(urlOf(new URL("https://example.test/b")), "https://example.test/b");
  assert.equal(urlOf(new Request("https://example.test/c")), "https://example.test/c");
});

test("the refusing fetch throws an error naming the URL and the hint, and restore puts the real fetch back", async () => {
  const real = globalThis.fetch;
  const restore = refuseNetwork({ hint: "See the stubs." });
  try {
    await assert.rejects(fetch("https://example.test/x"), /asked for https:\/\/example\.test\/x\. See the stubs\.$/);
  } finally {
    restore();
  }
  assert.equal(globalThis.fetch, real);
});

test("installs restore in reverse order, as a stack", async () => {
  const real = globalThis.fetch;
  const first = async () => new Response("first");
  const restoreFirst = installFetch(first);
  const restoreSecond = installFetch(async () => new Response("second"));
  assert.equal(await (await fetch("https://example.test")).text(), "second");
  restoreSecond();
  assert.equal(globalThis.fetch, first);
  restoreFirst();
  assert.equal(globalThis.fetch, real);
});
