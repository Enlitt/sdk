/**
 * The authorization callback a business mounts at its registered redirect URL,
 * and the one place a consumer session token becomes a cookie.
 *
 * This is the mint end of the token's lifecycle. Login-start issues the
 * `state`, the callback validates it, exchanges the one-time code with Enlitt
 * authenticated by the business's own secret key, and sets the resulting
 * opaque session token as an HttpOnly, Secure, SameSite=Lax cookie on the
 * business's own domain. Reading that cookie back on later requests is
 * `./session.ts`, which SDK-side routing owns and which also owns the
 * cookie's name: the mint end and the read end of one cookie cannot disagree,
 * so the default comes from there rather than from a second literal here.
 *
 * The core here is framework-agnostic over `Request` and `Response`;
 * per-framework adapters are separate entry points over this same core, so
 * behaviour cannot drift between frameworks.
 *
 * Invariants this file exists to hold:
 *
 *  - No cookie is ever set from an unverified value, and no token supplied in
 *    the callback request itself is ever honoured — the only source of a
 *    session token is the authenticated exchange response.
 *  - The token and the one-time code are never written into a URL, a redirect
 *    target, a log line, a trace, or an error body. Nothing in this file
 *    prints.
 *  - Every onward redirect resolves to `appOrigin` or is replaced by
 *    `defaultReturnTo`, so a login link can never become an open redirect.
 *  - A rejected `state`, a failed exchange, or an Enlitt error yields a
 *    signed-out outcome and no cookie. A rejected `state` lands on
 *    `defaultReturnTo`; after a live `state`, the stored `returnTo`.
 */

import { resolveBusinessAuthorizationHeader } from "./secrets.js";
import { ENLITT_SESSION_COOKIE_NAME } from "../core/session.js";
import { ENLITT_API_VERSION, ENLITT_VERSION_HEADER, validateAuthorizationExchangeResponse } from "@enlitt/protocol";

/** A store may be synchronous (an in-process map) or asynchronous (Redis). */
type Awaitable<T> = T | Promise<T>;

/**
 * What login-start remembers about a pending login, server-side.
 *
 * The post-login destination is captured here rather than carried through the
 * round trip in a parameter the callback reads back, so a crafted callback URL
 * has nothing to say about where the consumer lands.
 */
export interface StateRecord {
  /** The destination requested at login-start, still unvalidated. */
  readonly returnTo?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/**
 * Server-side storage for issued `state` values, with a TTL.
 *
 * `consume` must be single-use: it returns the record and removes it in one
 * step, so a replayed callback finds nothing. `get` exists for callers that
 * need to inspect a pending login without spending it; the callback handler
 * never uses it.
 */
export interface StateStore {
  set(state: string, record: StateRecord, ttlMs: number): Awaitable<void>;
  get(state: string): Awaitable<StateRecord | null>;
  consume(state: string): Awaitable<StateRecord | null>;
}

export interface CallbackConfig {
  readonly clientId: string;
  /** Falls back to `ENLITT_SECRET_KEY`; never reaches a browser bundle. */
  readonly secretKey?: string;
  /** Must equal a registered redirect URI exactly. */
  readonly redirectUri: string;
  /** Enlitt's authorization origin (the dashboard host). Defaults to the deployed one. */
  readonly enlittOrigin?: string;
  /**
   * Origin for the two server-to-server requests (code exchange and
   * revocation). Defaults to `enlittOrigin`. A server running as a Cloudflare
   * Worker in Enlitt's own zone must pass the API host: Cloudflare does not run
   * the route-bound Worker behind `enlittOrigin/auth/*` for a same-zone Worker
   * subrequest, so the exchange would reach the wrong Worker and fail.
   */
  readonly enlittApiOrigin?: string;
  /** The business's own origin. It bounds every redirect this file emits. */
  readonly appOrigin: string;
  /** Path on `appOrigin`, used whenever no valid destination survives. */
  readonly defaultReturnTo: string;
  readonly cookieName?: string;
  readonly stateStore: StateStore;
  /** Link your own user/session before login completes; no token is passed. */
  readonly onSignIn?: (identity: { readonly subject: string }, response: Response) => Awaitable<void>;
}

/**
 * The deployed Enlitt authorization origin: the dashboard host, not the model
 * API host. The consumer's browser is sent to `AUTHORIZE_PATH` here, and only
 * this host carries the consumer's Enlitt dashboard session cookie, so an
 * authorize request sent to the API host would always find the consumer
 * signed out. Model calls keep their own default in `../language-model.ts`.
 */
const DEFAULT_ENLITT_ORIGIN = "https://enlitt.com";

/**
 * Enlitt's authorization-server endpoints, under the `/auth/*` prefix the
 * backend serves.
 */
const AUTHORIZE_PATH = "/auth/oauth2/authorize";
const TOKEN_PATH = "/auth/oauth2/token";
const REVOKE_PATH = "/auth/oauth2/revoke";

/**
 * The query parameter carrying a post-flow destination. `../browser/auth.ts`
 * writes this name; this file is the only place its value is validated.
 */
const RETURN_TO_PARAM = "return_to";

/** How long an issued `state` stays redeemable. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The `state` alphabet and length: 32 symbols over 62 characters is a little
 * over 190 bits.
 */
const STATE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const STATE_LENGTH = 32;

/**
 * The largest multiple of the alphabet size that fits in a byte.
 *
 * Bytes at or above this bound are discarded rather than reduced. A plain
 * `byte % 62` would map the first `256 % 62` symbols more often than the rest,
 * which silently costs entropy in a value whose only job is to be unguessable;
 * rejecting the tail is what makes the distribution exactly uniform.
 */
const STATE_BYTE_LIMIT = 256 - (256 % STATE_ALPHABET.length);

/** A cookie name: an HTTP token. */
const SAFE_COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Generate one `state` value from a cryptographically secure source, uniformly
 * over `STATE_ALPHABET`.
 */
function generateState(): string {
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (!source?.getRandomValues) {
    throw new Error(
      "@enlitt/sdk: no Web Crypto implementation is available, so no unguessable " +
        "login state can be generated. Node 20+, Deno, Bun, and Workers all provide one."
    );
  }

  let out = "";
  while (out.length < STATE_LENGTH) {
    // Over-draw: on average about 3% of bytes are rejected, so asking for a
    // little more than is needed usually finishes in one draw.
    const bytes = source.getRandomValues(new Uint8Array(STATE_LENGTH));
    for (const byte of bytes) {
      if (byte >= STATE_BYTE_LIMIT) continue;
      out += STATE_ALPHABET[byte % STATE_ALPHABET.length];
      if (out.length === STATE_LENGTH) break;
    }
  }
  return out;
}

/**
 * Reduce a requested destination to a path on `appOrigin`, or reject it.
 *
 * The checks run on the raw form and on its single-decoded form, because a
 * server or proxy in front of the business may decode once before anything
 * else sees the value: `%2f%2fevil.com` is `//evil.com` to whoever decodes it,
 * and a scheme-relative target resolves to another origin. A traversal segment
 * is refused outright rather than normalised, since a destination that has to
 * climb out of a path is never a destination this handler was asked for.
 */
function safeReturnPath(target: string | null | undefined, appOrigin: string): string | null {
  if (typeof target !== "string" || target.length === 0) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // A malformed escape is not a destination.
    return null;
  }

  for (const form of [target, decoded]) {
    if (!form.startsWith("/")) return null;
    if (form.startsWith("//") || form.startsWith("/\\")) return null;
    if (form.includes("\\")) return null;
    if (form.split(/[/?#]/).includes("..")) return null;
    // Control characters, including a bare CR or LF, would split a `Location`
    // header. Checked by code point rather than by regex so the bytes being
    // refused are visible in the source rather than embedded in it.
    for (let i = 0; i < form.length; i += 1) {
      const point = form.charCodeAt(i);
      if (point < 0x20 || point === 0x7f) return null;
    }
  }

  let resolved: URL;
  let base: URL;
  try {
    base = new URL(appOrigin);
    resolved = new URL(target, base);
  } catch {
    return null;
  }
  // Belt and braces: whatever the parser made of it must still be here.
  if (resolved.origin !== base.origin) return null;

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

interface ResolvedConfig {
  readonly clientId: string;
  readonly secretKey?: string;
  readonly redirectUri: string;
  readonly enlittOrigin: string;
  readonly enlittApiOrigin: string;
  readonly appOrigin: string;
  readonly defaultReturnTo: string;
  readonly cookieName: string;
  readonly stateStore: StateStore;
  readonly onSignIn?: NonNullable<CallbackConfig["onSignIn"]>;
}

/**
 * Validate the configuration once, when the handler is built, rather than on
 * the first consumer request. A malformed origin is a deployment mistake and
 * should fail at boot.
 */
function resolveConfig(config: CallbackConfig): ResolvedConfig {
  if (config.onSignIn !== undefined && typeof config.onSignIn !== "function") {
    throw new Error("@enlitt/sdk: onSignIn must be a function.");
  }
  if (config.clientId.length === 0) {
    throw new Error("@enlitt/sdk: clientId is required.");
  }

  let appOrigin: string;
  try {
    appOrigin = new URL(config.appOrigin).origin;
  } catch {
    throw new Error("@enlitt/sdk: appOrigin must be an absolute origin, e.g. https://app.example.com.");
  }
  if (appOrigin === "null") {
    throw new Error("@enlitt/sdk: appOrigin must be an absolute origin, e.g. https://app.example.com.");
  }

  let enlittOrigin: string;
  try {
    enlittOrigin = new URL(config.enlittOrigin ?? DEFAULT_ENLITT_ORIGIN).origin;
  } catch {
    throw new Error("@enlitt/sdk: enlittOrigin must be an absolute origin.");
  }

  let enlittApiOrigin: string;
  try {
    enlittApiOrigin = new URL(config.enlittApiOrigin ?? enlittOrigin).origin;
  } catch {
    throw new Error("@enlitt/sdk: enlittApiOrigin must be an absolute origin.");
  }

  try {
    void new URL(config.redirectUri);
  } catch {
    throw new Error("@enlitt/sdk: redirectUri must be the absolute URL registered with Enlitt.");
  }

  const defaultReturnTo = safeReturnPath(config.defaultReturnTo, appOrigin);
  if (defaultReturnTo === null) {
    throw new Error("@enlitt/sdk: defaultReturnTo must be a path on appOrigin, e.g. \"/\".");
  }

  const cookieName = config.cookieName ?? ENLITT_SESSION_COOKIE_NAME;
  if (!SAFE_COOKIE_NAME.test(cookieName)) {
    throw new Error("@enlitt/sdk: cookieName must be a valid cookie name.");
  }

  const resolved: ResolvedConfig = {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    enlittOrigin,
    enlittApiOrigin,
    appOrigin,
    defaultReturnTo,
    cookieName,
    stateStore: config.stateStore,
    ...(config.onSignIn === undefined ? {} : { onSignIn: config.onSignIn })
  };
  // `exactOptionalPropertyTypes` keeps an absent secret absent rather than
  // present-and-undefined, so the fallback in `secrets.ts` still fires.
  return config.secretKey === undefined ? resolved : { ...resolved, secretKey: config.secretKey };
}

function redirectTo(location: string, cookie?: string): Response {
  const headers = new Headers({
    location,
    // A login outcome is never a cacheable page.
    "cache-control": "no-store"
  });
  if (cookie !== undefined) headers.append("set-cookie", cookie);
  // 303: whatever the callback's method was, the consumer now GETs a page.
  return new Response(null, { status: 303, headers });
}

function sessionCookie(name: string, value: string, maxAgeSeconds?: number): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(maxAgeSeconds)}`);
  return parts.join("; ");
}

function clearedCookie(name: string): string {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ].join("; ");
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value.length === 0 ? null : value;
  }
  return null;
}

/**
 * The exchange response, read defensively.
 *
 * The credential remains opaque. The separately verified subject links the
 * application's own user database and never becomes part of that credential.
 */
interface ExchangeResult {
  readonly sessionToken: string;
  readonly subject: string;
  readonly expiresInSeconds?: number;
}

function readExchangeResult(payload: unknown): ExchangeResult | null {
  const parsed = validateAuthorizationExchangeResponse(payload, { mode: "tolerant" });
  if (!parsed.ok) return null;
  const body = payload as Record<string, unknown>;
  const identity = { sessionToken: parsed.value.session_token, subject: parsed.value.subject };

  const expiresIn = body.expires_in;
  if (typeof expiresIn === "number" && Number.isInteger(expiresIn) && expiresIn > 0) {
    return { ...identity, expiresInSeconds: expiresIn };
  }
  return identity;
}

/**
 * Exchange the one-time code, authenticated as a confidential client.
 *
 * Returns `null` for every failure. No branch here reports what Enlitt said:
 * the code and the token must not reach a log, a trace, or an error body, and
 * the caller's only decision is signed in or signed out.
 */
async function exchangeCode(config: ResolvedConfig, code: string): Promise<ExchangeResult | null> {
  // Resolved before the request is built. A business with no secret gets a
  // local failure rather than an unauthenticated exchange attempt.
  const authorization = resolveBusinessAuthorizationHeader(
    config.secretKey === undefined ? {} : { secretKey: config.secretKey }
  );

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId
  });

  let response: Response;
  try {
    response = await fetch(new URL(TOKEN_PATH, config.enlittApiOrigin), {
      method: "POST",
      headers: {
        authorization,
        [ENLITT_VERSION_HEADER]: ENLITT_API_VERSION,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  try {
    return readExchangeResult(await response.json());
  } catch {
    return null;
  }
}

/**
 * Begin login: issue a `state`, remember it server-side, and send the consumer
 * to Enlitt's authorization endpoint.
 */
export function createLoginStartHandler(config: CallbackConfig): (request: Request) => Promise<Response> {
  const resolved = resolveConfig(config);

  return async function handleLoginStart(request: Request): Promise<Response> {
    const state = generateState();
    const now = Date.now();
    const requested = new URL(request.url).searchParams.get(RETURN_TO_PARAM);

    const base = { createdAt: now, expiresAt: now + STATE_TTL_MS };
    // The raw request is stored, not a validated one: validation happens where
    // the value is used, so a stored value can never be mistaken for a checked
    // one.
    await resolved.stateStore.set(
      state,
      requested === null ? base : { ...base, returnTo: requested },
      STATE_TTL_MS
    );

    const authorize = new URL(AUTHORIZE_PATH, resolved.enlittOrigin);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", resolved.clientId);
    authorize.searchParams.set("redirect_uri", resolved.redirectUri);
    authorize.searchParams.set("state", state);

    return redirectTo(authorize.toString());
  };
}

/**
 * Receive Enlitt's callback: validate `state`, exchange the code, set the one
 * cookie, and send the consumer onward within `appOrigin`.
 */
export function createCallbackHandler(config: CallbackConfig): (request: Request) => Promise<Response> {
  const resolved = resolveConfig(config);
  const signedOut = (): Response =>
    redirectTo(new URL(resolved.defaultReturnTo, resolved.appOrigin).toString());

  return async function handleCallback(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams;

    // `state` first, and spent before anything else happens: a missing,
    // unknown, replayed, or expired value must be refused before an exchange
    // is attempted, not after.
    const state = params.get("state");
    if (state === null || state.length === 0) return signedOut();

    const record = await resolved.stateStore.consume(state);
    if (record === null) return signedOut();
    if (record.expiresAt <= Date.now()) return signedOut();

    // From here on the `state` record is trusted, so every outcome — signed in
    // or not — goes to the page the consumer was heading for. A signed-out
    // arrival there carries no cookie; the page sees no session and acts on
    // it (client sign-in's `complete` reports `access_denied` this way).
    const destination =
      safeReturnPath(record.returnTo, resolved.appOrigin) ?? resolved.defaultReturnTo;
    const signedOutToDestination = (): Response =>
      redirectTo(new URL(destination, resolved.appOrigin).toString());

    // An `error` from Enlitt, or no code at all, ends the flow here. Nothing
    // else in the request can stand in for the code — a token parameter on the
    // callback URL is never read, because the only source of a session token
    // is the authenticated exchange below.
    if (params.get("error") !== null) return signedOutToDestination();
    const code = params.get("code");
    if (code === null || code.length === 0) return signedOutToDestination();

    const exchanged = await exchangeCode(resolved, code);
    if (exchanged === null) return signedOutToDestination();

    const response = redirectTo(new URL(destination, resolved.appOrigin).toString());
    // The application's session must be ready before the browser receives an
    // Enlitt credential. Propagate setup errors to its server, preserving the
    // original cause; never return a successful login after a failed hook.
    await resolved.onSignIn?.({ subject: exchanged.subject }, response);
    response.headers.append("set-cookie", sessionCookie(resolved.cookieName, exchanged.sessionToken, exchanged.expiresInSeconds));
    return response;
  };
}

/**
 * End the session: clear the cookie and ask Enlitt to revoke the token.
 *
 * Revocation is what makes the opaque token worth its lookup, so a signed-out
 * consumer is signed out server-side and not merely cookie-less. A revocation
 * that fails still clears the cookie: leaving the consumer holding a cookie
 * because Enlitt was briefly unreachable would be the worse of the two
 * outcomes, and the token stays revocable from the dashboard.
 */
export function createLogoutHandler(config: CallbackConfig): (request: Request) => Promise<Response> {
  const resolved = resolveConfig(config);

  return async function handleLogout(request: Request): Promise<Response> {
    const token = readCookie(request, resolved.cookieName);

    if (token !== null) {
      try {
        const authorization = resolveBusinessAuthorizationHeader(
          resolved.secretKey === undefined ? {} : { secretKey: resolved.secretKey }
        );
        await fetch(new URL(REVOKE_PATH, resolved.enlittApiOrigin), {
          method: "POST",
          headers: {
            authorization,
            [ENLITT_VERSION_HEADER]: ENLITT_API_VERSION,
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json"
          },
          // The token travels in the body, never in the URL.
          body: new URLSearchParams({ token, client_id: resolved.clientId })
        });
      } catch {
        // Deliberately swallowed and never reported: the outcome is the same
        // either way, and an error body here is a place a token could leak.
      }
    }

    const requested = new URL(request.url).searchParams.get(RETURN_TO_PARAM);
    const destination = safeReturnPath(requested, resolved.appOrigin) ?? resolved.defaultReturnTo;

    return redirectTo(
      new URL(destination, resolved.appOrigin).toString(),
      clearedCookie(resolved.cookieName)
    );
  };
}
