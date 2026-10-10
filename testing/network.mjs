// The network guard every test layer writes for itself: a global fetch that refuses, and the swap underneath it.
// Written once here (design-shared-tests.md, section 1) so the three copies stop drifting. No test framework is
// imported: the swap is a property definition, the same one vitest's stubGlobal makes, so it works in node and workerd.

/**
 * The URL a fetch was asked for, from any of the three shapes fetch accepts.
 *
 * @param {RequestInfo | URL} input
 * @returns {string}
 */
export function urlOf(input) {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/**
 * Replaces `globalThis.fetch` with `impl` and returns the function that puts back what was there. Restores run in the
 * reverse order of installs, as any stack of stubs does.
 *
 * @param {typeof fetch} impl
 * @returns {() => void}
 */
export function installFetch(impl) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", { value: impl, writable: true, configurable: true, enumerable: true });
  return () => {
    if (previous) Object.defineProperty(globalThis, "fetch", previous);
    else delete (/** @type {{ fetch?: unknown }} */ (globalThis)).fetch;
  };
}

/**
 * Installs a fetch that throws an error naming the URL, so reaching the network is a failure and never a silent call.
 * `hint` is appended to the message: where the layer's recorded stubs live. Returns the restore, so it can be a
 * vitest `beforeEach` return value.
 *
 * @param {{ hint?: string }} [options]
 * @returns {() => void}
 */
export function refuseNetwork({ hint } = {}) {
  return installFetch(async (input) => {
    throw new Error(
      `this layer does not reach the network, and something asked for ${urlOf(input)}.` + (hint ? ` ${hint}` : ""),
    );
  });
}
