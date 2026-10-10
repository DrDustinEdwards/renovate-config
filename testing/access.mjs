// A fake of Cloudflare Access as an OIDC provider (Access for SaaS), as a login callback reaches it: the token endpoint,
// answering with an RS256 ID token signed by a key made here, and the JWKS endpoint serving that key's public half.
// Taken from capsid's test-integration/access-stub.ts (design-shared-tests.md, section 1), with the issuer, the audience
// and the claims as parameters, vitest's spy replaced by the shared fetch swap, and capsid's own client-metadata routes
// left to a `fallback` the caller passes.
//
// An unknown URL THROWS, so a sign-in cannot fall through to the real Access. The token is really signed and the JWKS
// really serves its key, so the code under test verifies it exactly as it verifies Access's.

import { installFetch, urlOf } from "./network.mjs";

const KID = "stub-kid";
const encoder = new TextEncoder();

/** @param {Uint8Array} bytes */
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** @param {unknown} value */
const b64json = (value) => b64url(encoder.encode(JSON.stringify(value)));

/**
 * Stands up the fake for one Access application and one sign-in. Installed as the global fetch unless `install` is false.
 *
 * @param {{
 *   issuer: string,
 *   audience: string,
 *   email: string,
 *   authorizationUrl?: string,
 *   claims?: Record<string, unknown>,
 *   jwksUrl?: string,
 *   fallback?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
 *   install?: boolean,
 * }} options
 */
export async function stubAccess({ issuer, audience, email, authorizationUrl, claims = {}, jwksUrl, fallback, install = true }) {
  if (!issuer || !audience) throw new Error("stubAccess needs the issuer and audience of the Access application it stands in for.");
  const base = issuer.replace(/\/+$/, "");
  const tokenUrl = `${base}/token`;
  const keysUrl = jwksUrl ?? `${base}/jwks`;
  // The nonce the flow sent the browser away with, echoed as Access would.
  const nonce = authorizationUrl ? new URL(authorizationUrl).searchParams.get("nonce") : null;

  const pair = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )
  );
  const publicJwk = { ...(/** @type {JsonWebKey} */ (await crypto.subtle.exportKey("jwk", pair.publicKey))), kid: KID, alg: "RS256", use: "sig" };

  /**
   * A token signed by the stub's key: the issuer, the audience, a five-minute life and the sign-in's email and nonce,
   * then `claims` on top, then `extra`. Also what a test sends as Cf-Access-Jwt-Assertion.
   *
   * @param {Record<string, unknown>} [extra]
   */
  async function token(extra = {}) {
    const head = b64json({ alg: "RS256", kid: KID, typ: "JWT" });
    const now = Math.floor(Date.now() / 1000);
    const body = b64json({ iss: issuer, aud: audience, iat: now, exp: now + 300, email, ...(nonce ? { nonce } : {}), ...claims, ...extra });
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, encoder.encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(signature)}`;
  }

  /** @type {URLSearchParams[]} */
  const tokenRequests = [];

  /** @type {typeof fetch} */
  const fake = async (input, init) => {
    const url = urlOf(input);
    if (url === tokenUrl) {
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
      tokenRequests.push(new URLSearchParams(String(raw)));
      return Response.json({ id_token: await token(), token_type: "bearer" });
    }
    if (url === keysUrl) return Response.json({ keys: [publicJwk] });
    const other = fallback ? await fallback(url, init) : undefined;
    if (other) return other;
    throw new Error(`the Access stub does not answer ${url}; pass a fallback for the other routes this sign-in needs.`);
  };

  const restore = install ? installFetch(fake) : () => {};
  return { issuer, tokenUrl, jwksUrl: keysUrl, jwk: publicJwk, token, tokenRequests, fetch: fake, restore };
}
