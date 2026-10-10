/** The URL a fetch was asked for, from any of the three shapes fetch accepts. */
export function urlOf(input: RequestInfo | URL): string;
/**
 * Replaces `globalThis.fetch` with `impl` and returns the function that puts back what was there. Restores run in the
 * reverse order of installs.
 */
export function installFetch(impl: typeof fetch): () => void;
/**
 * Installs a fetch that throws an error naming the URL. `hint` is appended to the message. Returns the restore, so it
 * can be a vitest `beforeEach` return value.
 */
export function refuseNetwork(options?: { hint?: string }): () => void;
