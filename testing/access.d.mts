export type AccessStub = {
  issuer: string;
  /** `<issuer>/token`, where the ID token is answered. */
  tokenUrl: string;
  /** Where the public key is served: `jwksUrl` when given, `<issuer>/jwks` otherwise. */
  jwksUrl: string;
  /** The public half of the signing key, as the JWKS serves it. */
  jwk: JsonWebKey & { kid: string };
  /** A token signed by the stub's key, with the sign-in's claims and `extra` on top. Also usable as Cf-Access-Jwt-Assertion. */
  token: (extra?: Record<string, unknown>) => Promise<string>;
  /** The form bodies the token endpoint received, so a test can read the PKCE verifier and redirect_uri sent. */
  tokenRequests: URLSearchParams[];
  /** The fake itself, for code that takes a fetch rather than reading the global. */
  fetch: typeof fetch;
  /** Puts back the global fetch the stub replaced. A no-op when it was created with `install: false`. */
  restore: () => void;
};

/**
 * Stands up a fake Access for SaaS for one sign-in: the token endpoint answers an RS256 ID token signed by a key made
 * here, and the JWKS serves its public half. Installed as the global fetch unless `install` is false. An unknown URL
 * throws unless `fallback` answers it.
 */
export function stubAccess(options: {
  issuer: string;
  audience: string;
  email: string;
  /** The authorization URL the flow sent the browser to; its nonce is echoed in the token. */
  authorizationUrl?: string;
  /** Claims added to every token, over the defaults. */
  claims?: Record<string, unknown>;
  /** Default `<issuer>/jwks`. */
  jwksUrl?: string;
  /** Answers any other URL the sign-in reaches; return undefined to refuse it. */
  fallback?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  /** Default true. */
  install?: boolean;
}): Promise<AccessStub>;
