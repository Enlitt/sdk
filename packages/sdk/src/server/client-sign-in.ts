/**
 * Client sign-in handoff: the business-hosted half of signing in a game or
 * native client that has no cookie jar and no secret.
 *
 * The wire is `specs/PROTOCOLS.md` "Client sign-in handoff"; the behavior is
 * `specs/Account.md` "Client sign-in handoff". In short, the business's own
 * backend runs the ordinary Enlitt login in the player's browser (through the
 * existing `createLoginStartHandler` / `createCallbackHandler` pair), then hands
 * the resulting opaque session token to the client over a PKCE-protected
 * one-time code (loopback, deep link) or a device-style pairing code. Enlitt sees
 * only its unchanged authorization, code exchange, and revocation routes.
 *
 * One handler serves every path under `basePath`:
 *
 *   GET  <base>/start      begin a loopback or deep-link sign-in
 *   GET  <base>/complete   reached only through the business's own callback redirect
 *   POST <base>/pairing    begin a pairing (device-style) sign-in
 *   GET/POST <base>/pair   the HTML pages the person opens on another device
 *   POST <base>/token      the client trades a code or pairing for the session token
 *   POST <base>/logout     the client ends its session
 *
 * The session token leaves this file only in the `token` response body. It is
 * never written to a URL, a page, a log, or an error.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import {
  ENLITT_SESSION_COOKIE_NAME,
  ENLITT_SESSION_HEADER_NAME,
  EnlittConfigurationError
} from "../core/index.js";
import { createLoginStartHandler, createLogoutHandler, type CallbackConfig } from "./callback.js";

type Awaitable<T> = T | Promise<T>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Server-side storage for handoffs, codes, and pairings. Values are opaque
 * strings: the handler owns their format (JSON it writes and parses itself).
 * Like `StateStore`, it must be shared across processes in a multi-process
 * deployment. `consume` is an atomic read-and-delete, which is what makes a code
 * single-use.
 */
export interface ClientSignInStore {
  /** Stores `value` under `key`, overwriting any existing value, for `ttlMs`. */
  set(key: string, value: string, ttlMs: number): Awaitable<void>;
  get(key: string): Awaitable<string | null>;
  consume(key: string): Awaitable<string | null>;
}

export interface ClientSignInConfig {
  /** The same object the login-start, callback, and logout handlers are mounted with. */
  readonly callback: CallbackConfig;
  /** Path on `callback.appOrigin`, e.g. `/enlitt/client`; no trailing slash. */
  readonly basePath: string;
  /** Shown on the pairing pages (1-60 characters). */
  readonly appName: string;
  /** Allow `mode=loopback` sign-ins to `127.0.0.1`. Defaults to true. */
  readonly loopback?: boolean;
  /** Exact deep-link targets allowed for `mode=redirect`. Defaults to none. */
  readonly returnUrls?: readonly string[];
  /** Serve the pairing routes. Defaults to false. */
  readonly pairing?: boolean;
  /** Shared across processes, like `callback.stateStore`. */
  readonly store: ClientSignInStore;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a started sign-in (the handoff) may take, and how long a pairing lives. */
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
/** How long a one-time code may wait for the client to redeem it. */
const CODE_TTL_MS = 5 * 60 * 1000;
/** Seconds a pairing client waits between `token` polls. */
const PAIRING_INTERVAL_SECONDS = 5;

/** Pairing user codes: 8 letters from an alphabet with no vowels and no look-alikes. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

/** The CSRF double-submit cookie of the pairing pages. */
const CSRF_COOKIE_NAME = "enlitt_pair_csrf";

/** Value rules from PROTOCOLS "Client sign-in handoff / Shared value rules". */
const STATE_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Codes and pairing IDs are 32 random bytes in unpadded base64url. */
const RANDOM_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Schemes a private-use `returnUrls` entry may never use. */
const FORBIDDEN_SCHEMES = new Set(["http", "javascript", "data", "file", "vbscript"]);

/** Longest `Enlitt-Session` header value `logout` forwards. */
const MAX_LOGOUT_TOKEN_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Stored record shapes (JSON the handler writes and parses itself)
// ---------------------------------------------------------------------------

type HandoffTarget =
  | { readonly mode: "loopback"; readonly port: number }
  | { readonly mode: "redirect"; readonly redirectUri: string }
  | { readonly mode: "pairing"; readonly pairingId: string };

/** `h:<id>`: a started sign-in, waiting for the business's callback redirect. */
interface Handoff {
  readonly target: HandoffTarget;
  /** Echoed to loopback/redirect targets; absent for pairing. */
  readonly state?: string;
  readonly codeChallenge: string;
}

/** `c:<code>`: a one-time code waiting for the client to redeem it. */
interface CodeRecord {
  readonly sessionToken: string;
  readonly codeChallenge: string;
}

/** `p:<pairing id>` (and `u:<user code>` pointing at it). */
interface PairingRecord {
  readonly status: "pending" | "ready" | "denied";
  readonly codeChallenge: string;
  readonly userCode: string;
  readonly sessionToken?: string;
  /** Absolute expiry in epoch ms, so an update can keep the time left. */
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// In-memory store (development only)
// ---------------------------------------------------------------------------

/** Options for `createMemoryClientSignInStore()`. */
export interface MemoryClientSignInStoreOptions {
  /** Clock in epoch milliseconds; defaults to `Date.now`. Tests inject one. */
  readonly now?: () => number;
}

/**
 * A `ClientSignInStore` held in this process's memory, for development and
 * tests. It does NOT work across processes or restarts: a code started on one
 * server instance cannot be redeemed on another. Production uses a shared store
 * (Redis, a database) implementing the same three methods.
 */
export function createMemoryClientSignInStore(
  options: MemoryClientSignInStoreOptions = {}
): ClientSignInStore {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: string; expiresAt: number }>();

  /** Reads a live entry, dropping it first when its TTL has passed. */
  function live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = entries.get(key);
    if (entry !== undefined && entry.expiresAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    set(key, value, ttlMs) {
      // Opportunistic sweep so abandoned sign-ins do not accumulate forever.
      if (entries.size > 1000) {
        for (const existing of [...entries.keys()]) live(existing);
      }
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    get(key) {
      return live(key)?.value ?? null;
    },
    consume(key) {
      const entry = live(key);
      entries.delete(key);
      return entry?.value ?? null;
    }
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** 32 cryptographically random bytes as 43 characters of unpadded base64url. */
function randomId(): string {
  return randomBytes(32).toString("base64url");
}

/** `base64url(SHA-256(ASCII(verifier)))`: the PKCE S256 transform. */
function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Constant-time string equality; unequal lengths are simply unequal. */
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A user code: 8 letters from `USER_CODE_ALPHABET`. `randomInt` draws by
 * rejection sampling, so no letter is more likely than another.
 */
function randomUserCode(): string {
  let code = "";
  for (let i = 0; i < USER_CODE_LENGTH; i += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

/** `ABCDEFGH` shown as `ABCD-EFGH`. */
function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Uppercases and drops every non-letter, so people may type `abcd efgh`. */
function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z]/g, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Parses a stored JSON object, or null for anything else (never throws). */
function parseRecord(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readHandoff(text: string | null): Handoff | null {
  const record = parseRecord(text);
  if (record === null || typeof record.codeChallenge !== "string") return null;
  const target = record.target as Record<string, unknown> | null | undefined;
  if (typeof target !== "object" || target === null) return null;
  if (target.mode === "loopback" && typeof target.port === "number") {
    return record as unknown as Handoff;
  }
  if (target.mode === "redirect" && typeof target.redirectUri === "string") {
    return record as unknown as Handoff;
  }
  if (target.mode === "pairing" && typeof target.pairingId === "string") {
    return record as unknown as Handoff;
  }
  return null;
}

function readCode(text: string | null): CodeRecord | null {
  const record = parseRecord(text);
  if (
    record === null ||
    typeof record.sessionToken !== "string" ||
    typeof record.codeChallenge !== "string"
  ) {
    return null;
  }
  return { sessionToken: record.sessionToken, codeChallenge: record.codeChallenge };
}

function readPairing(text: string | null): PairingRecord | null {
  const record = parseRecord(text);
  if (
    record === null ||
    (record.status !== "pending" && record.status !== "ready" && record.status !== "denied") ||
    typeof record.codeChallenge !== "string" ||
    typeof record.userCode !== "string" ||
    typeof record.expiresAt !== "number"
  ) {
    return null;
  }
  return record as unknown as PairingRecord;
}

/** Reads one cookie off the request's `Cookie` header, or null. */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** Security headers every HTML page carries. */
const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer"
};

/** Wraps `body` (already-escaped HTML) in a minimal page and security headers. */
function htmlPage(
  status: number,
  title: string,
  body: string,
  extraHeaders: Headers = new Headers()
): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}` +
    `button,input{font:inherit;padding:.5rem 1rem;margin:.25rem 0}.code{font-size:2rem;letter-spacing:.2em;font-weight:600}</style>` +
    `</head><body>${body}</body></html>`;
  const headers = new Headers(extraHeaders);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
  return new Response(html, { status, headers });
}

/** The plain `400` page for a refused `start`. It echoes nothing the client sent. */
function invalidRequestPage(): Response {
  return htmlPage(
    400,
    "Sign-in unavailable",
    "<p>This sign-in request is not valid. Go back to the app and try again.</p>"
  );
}

function expiredPage(): Response {
  return htmlPage(
    400,
    "Sign-in expired",
    "<p>This sign-in link has expired. Go back to the app and try again.</p>"
  );
}

/** A JSON response that is never cached. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function tokenError(error: string): Response {
  return jsonResponse(400, { error });
}

/** Parses a JSON request body that must be an object, or null. */
async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return null;
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True when `object` has exactly the keys in `keys`. */
function hasExactKeys(object: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(object);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(object, key))
  );
}

// ---------------------------------------------------------------------------
// Construction checks
// ---------------------------------------------------------------------------

/**
 * Checks one `returnUrls` entry: an absolute URL without a fragment that is
 * either `https:` or a private-use reverse-DNS scheme (lowercase, containing a
 * `.`, and not a scheme a browser would treat specially).
 */
function checkReturnUrl(entry: string): void {
  const refuse = (): never => {
    throw new EnlittConfigurationError(
      `createClientSignInHandler(): returnUrls entry ${JSON.stringify(entry)} must be an absolute ` +
        "https: URL or a private-use reverse-DNS scheme (for example com.example.game://auth), without a fragment."
    );
  };
  if (typeof entry !== "string" || entry.includes("#")) return refuse();
  try {
    new URL(entry);
  } catch {
    return refuse();
  }
  const colon = entry.indexOf(":");
  const scheme = entry.slice(0, colon);
  if (scheme === "https") return;
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(scheme) || FORBIDDEN_SCHEMES.has(scheme)) {
    return refuse();
  }
}

function checkConfig(config: ClientSignInConfig): void {
  const { basePath } = config;
  if (
    typeof basePath !== "string" ||
    !basePath.startsWith("/") ||
    basePath.endsWith("/") ||
    basePath.includes("?") ||
    basePath.includes("#")
  ) {
    throw new EnlittConfigurationError(
      "createClientSignInHandler(): basePath must start with '/', must not end with '/', " +
        "and must not contain '?' or '#'."
    );
  }
  for (const entry of config.returnUrls ?? []) checkReturnUrl(entry);
  const loopback = config.loopback ?? true;
  if (!loopback && (config.returnUrls ?? []).length === 0 && config.pairing !== true) {
    throw new EnlittConfigurationError(
      "createClientSignInHandler(): enable at least one of loopback, returnUrls, or pairing."
    );
  }
  if (
    typeof config.appName !== "string" ||
    config.appName.length < 1 ||
    config.appName.length > 60
  ) {
    throw new EnlittConfigurationError(
      "createClientSignInHandler(): appName must be 1-60 characters."
    );
  }
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * Builds the single handler that serves every path under `config.basePath`.
 * Mount it with one catch-all route. Construction throws
 * `EnlittConfigurationError` for a bad config, never at the first request.
 *
 * The business must rate-limit `POST <basePath>/pair` and `POST <basePath>/token`
 * per client IP with its own limiter; this handler has none.
 */
export function createClientSignInHandler(
  config: ClientSignInConfig
): (request: Request) => Promise<Response> {
  checkConfig(config);

  const { store, basePath, appName } = config;
  const loopbackEnabled = config.loopback ?? true;
  const returnUrls = config.returnUrls ?? [];
  const pairingEnabled = config.pairing === true;
  const appOrigin = new URL(config.callback.appOrigin).origin;
  const cookieName = config.callback.cookieName ?? ENLITT_SESSION_COOKIE_NAME;
  const loginStart = createLoginStartHandler(config.callback);
  const logoutHandler = createLogoutHandler(config.callback);

  /**
   * A `Set-Cookie` that clears the Enlitt session cookie.
   *
   * Cleared at `start` so a session cookie seen at `complete` was minted by
   * this very sign-in (otherwise a browser already signed in to the business's
   * website would hand its existing web session to the client), and cleared at
   * `complete` because the token now belongs to the client and the browser must
   * not keep a second copy.
   */
  const clearSessionCookie = `${cookieName}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

  /** A `303` to `location` that clears the session cookie and is never cached. */
  function redirectClearingCookie(location: string): Response {
    const headers = new Headers({
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    });
    headers.append("Set-Cookie", clearSessionCookie);
    return new Response(null, { status: 303, headers });
  }

  /**
   * Writes the handoff and sends the browser into the business's login start
   * with `return_to` pointing back at `complete`. Shared by `start` and the
   * pairing confirmation, so the cookie clearing cannot differ between them.
   */
  async function beginLogin(handoff: Handoff): Promise<Response> {
    const id = randomId();
    await store.set(`h:${id}`, JSON.stringify(handoff), HANDOFF_TTL_MS);
    const returnTo = `${basePath}/complete?${new URLSearchParams({ h: id }).toString()}`;
    const internal = new Request(
      `${appOrigin}${basePath}/start?${new URLSearchParams({ return_to: returnTo }).toString()}`,
      { method: "GET" }
    );
    const response = await loginStart(internal);
    // Rebuild the response so its headers are certainly mutable, then add the cookie clearing.
    const headers = new Headers(response.headers);
    headers.append("Set-Cookie", clearSessionCookie);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  // ---- start ---------------------------------------------------------------

  async function start(url: URL): Promise<Response> {
    const params = url.searchParams;
    const names = [...params.keys()];
    // Every parameter must appear exactly once.
    if (new Set(names).size !== names.length) return invalidRequestPage();

    const mode = params.get("mode");
    const allowed = ["mode", "state", "code_challenge", "code_challenge_method"];
    if (mode === "loopback" && loopbackEnabled) allowed.push("port");
    else if (mode === "redirect" && returnUrls.length > 0) allowed.push("redirect_uri");
    else return invalidRequestPage(); // unknown, pairing-only, or disabled mode
    if (names.length !== allowed.length || !names.every((name) => allowed.includes(name))) {
      return invalidRequestPage();
    }

    const state = params.get("state") ?? "";
    const codeChallenge = params.get("code_challenge") ?? "";
    if (!STATE_PATTERN.test(state)) return invalidRequestPage();
    if (!CODE_CHALLENGE_PATTERN.test(codeChallenge)) return invalidRequestPage();
    if (params.get("code_challenge_method") !== "S256") return invalidRequestPage();

    let target: HandoffTarget;
    if (mode === "loopback") {
      const rawPort = params.get("port") ?? "";
      const port = Number(rawPort);
      // Canonical decimal only: "08080" and "8080.0" are refused.
      if (
        !/^[0-9]{4,5}$/.test(rawPort) ||
        String(port) !== rawPort ||
        port < 1024 ||
        port > 65535
      ) {
        return invalidRequestPage();
      }
      target = { mode: "loopback", port };
    } else {
      const redirectUri = params.get("redirect_uri") ?? "";
      // Exact match against the configured list; nothing else is ever trusted.
      if (!returnUrls.includes(redirectUri)) return invalidRequestPage();
      target = { mode: "redirect", redirectUri };
    }

    return beginLogin({ target, state, codeChallenge });
  }

  // ---- complete ------------------------------------------------------------

  /** Appends query parameters to a client target and redirects there. */
  function redirectToTarget(base: string, query: Record<string, string>): Response {
    const target = new URL(base);
    for (const [name, value] of Object.entries(query)) target.searchParams.append(name, value);
    return redirectClearingCookie(target.toString());
  }

  async function complete(request: Request, url: URL): Promise<Response> {
    const id = url.searchParams.get("h") ?? "";
    const handoff = readHandoff(await store.consume(`h:${id}`));
    if (handoff === null) return expiredPage();

    // The session cookie is the one the business's callback just set, because
    // `start` cleared any earlier one.
    const sessionToken = readCookie(request, cookieName);
    const hasSession = sessionToken !== null && sessionToken !== "";

    const { target } = handoff;
    if (target.mode === "pairing") {
      const key = `p:${target.pairingId}`;
      const pairing = readPairing(await store.get(key));
      const remaining = pairing === null ? 0 : pairing.expiresAt - Date.now();
      if (pairing === null || remaining <= 0) return expiredPage();
      const updated: PairingRecord = hasSession
        ? { ...pairing, status: "ready", sessionToken }
        : { ...pairing, status: "denied" };
      await store.set(key, JSON.stringify(updated), remaining);
      const headers = new Headers();
      headers.append("Set-Cookie", clearSessionCookie);
      return hasSession
        ? htmlPage(
            200,
            "Signed in",
            "<p>Signed in. You can go back to your other device.</p>",
            headers
          )
        : htmlPage(
            200,
            "Sign-in cancelled",
            "<p>Sign-in cancelled. You can close this page.</p>",
            headers
          );
    }

    const base =
      target.mode === "loopback" ? `http://127.0.0.1:${target.port}/callback` : target.redirectUri;
    const state = handoff.state ?? "";
    if (!hasSession) return redirectToTarget(base, { error: "access_denied", state });

    const code = randomId();
    const record: CodeRecord = { sessionToken, codeChallenge: handoff.codeChallenge };
    await store.set(`c:${code}`, JSON.stringify(record), CODE_TTL_MS);
    return redirectToTarget(base, { code, state });
  }

  // ---- pairing -------------------------------------------------------------

  async function pairing(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    if (
      body === null ||
      !hasExactKeys(body, ["code_challenge", "code_challenge_method"]) ||
      typeof body.code_challenge !== "string" ||
      !CODE_CHALLENGE_PATTERN.test(body.code_challenge) ||
      body.code_challenge_method !== "S256"
    ) {
      return tokenError("invalid_request");
    }

    // A user code that collides with a live one is simply redrawn.
    let userCode = randomUserCode();
    while ((await store.get(`u:${userCode}`)) !== null) userCode = randomUserCode();

    const pairingId = randomId();
    const record: PairingRecord = {
      status: "pending",
      codeChallenge: body.code_challenge,
      userCode,
      expiresAt: Date.now() + PAIRING_TTL_MS
    };
    await store.set(`p:${pairingId}`, JSON.stringify(record), PAIRING_TTL_MS);
    await store.set(`u:${userCode}`, pairingId, PAIRING_TTL_MS);

    return jsonResponse(200, {
      pairing_id: pairingId,
      user_code: userCode,
      verification_uri: `${appOrigin}${basePath}/pair`,
      expires_in: PAIRING_TTL_MS / 1000,
      interval: PAIRING_INTERVAL_SECONDS
    });
  }

  // ---- pair pages ----------------------------------------------------------

  /** A page carrying the CSRF cookie, so every form on it can double-submit. */
  function csrfCookieHeaders(csrf: string): Headers {
    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      `${CSRF_COOKIE_NAME}=${csrf}; HttpOnly; Secure; SameSite=Strict; Path=${basePath}`
    );
    return headers;
  }

  function entryFormPage(csrf: string, message?: string): Response {
    const notice = message === undefined ? "" : `<p role="alert">${escapeHtml(message)}</p>`;
    return htmlPage(
      200,
      `Sign in to ${appName}`,
      `<h1>Sign in to ${escapeHtml(appName)}</h1>${notice}` +
        `<form method="post" action="${escapeHtml(basePath)}/pair">` +
        `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
        `<label>Code shown on your other device<br>` +
        `<input name="user_code" autocomplete="off" autocapitalize="characters" required></label><br>` +
        `<button type="submit">Next</button></form>`,
      csrfCookieHeaders(csrf)
    );
  }

  function confirmationPage(csrf: string, userCode: string): Response {
    const shown = escapeHtml(formatUserCode(userCode));
    return htmlPage(
      200,
      `Sign in to ${appName}`,
      `<h1>Sign in to ${escapeHtml(appName)} on another device?</h1>` +
        `<p class="code">${shown}</p>` +
        `<p>Sign in to ${escapeHtml(appName)} on another device? Only continue if this code is on a screen ` +
        `in front of you right now. If someone sent you this code, do not continue — they are trying to use your account.</p>` +
        `<form method="post" action="${escapeHtml(basePath)}/pair">` +
        `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
        `<input type="hidden" name="user_code" value="${escapeHtml(userCode)}">` +
        `<button type="submit" name="action" value="confirm">Continue</button> ` +
        `<button type="submit" name="action" value="cancel">Cancel</button></form>`,
      csrfCookieHeaders(csrf)
    );
  }

  /** Looks up the pending pairing a (normalized) user code names. */
  async function pendingPairingFor(
    userCode: string
  ): Promise<{ id: string; record: PairingRecord } | null> {
    if (userCode.length !== USER_CODE_LENGTH) return null;
    const id = await store.get(`u:${userCode}`);
    if (id === null) return null;
    const record = readPairing(await store.get(`p:${id}`));
    if (record?.status !== "pending" || record.expiresAt <= Date.now()) return null;
    return { id, record };
  }

  async function pair(request: Request): Promise<Response> {
    if (request.method === "GET") return entryFormPage(randomId());

    // POST: double-submit CSRF plus an Origin check.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== appOrigin) return forbidden();
    const cookieCsrf = readCookie(request, CSRF_COOKIE_NAME);
    const form = new URLSearchParams(await request.text());
    const csrf = form.get("csrf");
    if (cookieCsrf === null || csrf === null || cookieCsrf === "" || !safeEqual(cookieCsrf, csrf)) {
      return forbidden();
    }

    const userCode = normalizeUserCode(form.get("user_code") ?? "");
    const action = form.get("action");
    const found = await pendingPairingFor(userCode);
    if (found === null) return entryFormPage(csrf, "That code is not valid or has expired.");

    if (action === "cancel") {
      const remaining = found.record.expiresAt - Date.now();
      await store.set(
        `p:${found.id}`,
        JSON.stringify({ ...found.record, status: "denied" }),
        remaining
      );
      return htmlPage(
        200,
        "Sign-in cancelled",
        "<p>Sign-in cancelled. You can close this page.</p>"
      );
    }
    if (action === "confirm") {
      return beginLogin({
        target: { mode: "pairing", pairingId: found.id },
        codeChallenge: found.record.codeChallenge
      });
    }
    return confirmationPage(csrf, userCode);
  }

  function forbidden(): Response {
    return htmlPage(
      403,
      "Forbidden",
      "<p>This request could not be verified. Go back and try again.</p>"
    );
  }

  // ---- token ---------------------------------------------------------------

  async function token(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    if (body === null) return tokenError("invalid_request");

    const verifier = body.code_verifier;
    if (body.grant_type === "code") {
      if (!hasExactKeys(body, ["grant_type", "code", "code_verifier"]))
        return tokenError("invalid_request");
      if (typeof body.code !== "string" || typeof verifier !== "string")
        return tokenError("invalid_request");
      return redeemCode(body.code, verifier);
    }
    if (body.grant_type === "pairing") {
      if (!hasExactKeys(body, ["grant_type", "pairing_id", "code_verifier"]))
        return tokenError("invalid_request");
      if (typeof body.pairing_id !== "string" || typeof verifier !== "string")
        return tokenError("invalid_request");
      return redeemPairing(body.pairing_id, verifier);
    }
    return tokenError("invalid_request");
  }

  /** True when `verifier` is well formed and hashes to `challenge`. */
  function verifierMatches(verifier: string, challenge: string): boolean {
    return CODE_VERIFIER_PATTERN.test(verifier) && safeEqual(challengeOf(verifier), challenge);
  }

  /**
   * Redeems a code. It is consumed before the verifier is compared, so every
   * code is single-use and a wrong verifier also spends it.
   */
  async function redeemCode(code: string, verifier: string): Promise<Response> {
    if (!RANDOM_ID_PATTERN.test(code)) return tokenError("invalid_grant");
    const record = readCode(await store.consume(`c:${code}`));
    if (record === null || !verifierMatches(verifier, record.codeChallenge))
      return tokenError("invalid_grant");
    return jsonResponse(200, { session_token: record.sessionToken });
  }

  async function redeemPairing(pairingId: string, verifier: string): Promise<Response> {
    if (!RANDOM_ID_PATTERN.test(pairingId)) return tokenError("invalid_grant");
    const key = `p:${pairingId}`;
    const current = readPairing(await store.get(key));
    if (current === null) return tokenError("invalid_grant");
    // Still waiting for the person: leave the pairing alone so the client polls again.
    if (current.status === "pending" && current.expiresAt > Date.now())
      return tokenError("authorization_pending");

    // Anything else ends the pairing now. Decide on the record this call
    // actually consumed, so two racing polls cannot both succeed.
    const record = readPairing(await store.consume(key));
    if (record === null) return tokenError("invalid_grant");
    await store.consume(`u:${record.userCode}`);

    if (record.expiresAt <= Date.now() && record.status === "pending")
      return tokenError("expired_token");
    if (record.status === "denied") return tokenError("access_denied");
    if (record.status !== "ready" || record.sessionToken === undefined)
      return tokenError("invalid_grant");
    if (!verifierMatches(verifier, record.codeChallenge)) return tokenError("invalid_grant");
    return jsonResponse(200, { session_token: record.sessionToken });
  }

  // ---- logout --------------------------------------------------------------

  /**
   * Revokes the header token through the callback's logout handler, so
   * revocation has exactly one implementation. Always answers `204`.
   */
  async function logout(request: Request): Promise<Response> {
    const sessionToken = request.headers.get(ENLITT_SESSION_HEADER_NAME);
    if (
      sessionToken !== null &&
      sessionToken !== "" &&
      sessionToken.length <= MAX_LOGOUT_TOKEN_LENGTH
    ) {
      try {
        await logoutHandler(
          new Request(`${appOrigin}${basePath}/logout`, {
            method: "POST",
            headers: { cookie: `${cookieName}=${encodeURIComponent(sessionToken)}` }
          })
        );
      } catch {
        // A revocation failure has the same outcome as success for the client.
      }
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  // ---- routing -------------------------------------------------------------

  function methodNotAllowed(allow: string): Response {
    return new Response(null, {
      status: 405,
      headers: { Allow: allow, "Cache-Control": "no-store" }
    });
  }

  function notFound(): Response {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  return async function handleClientSignIn(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${basePath}/`)) return notFound();
    const route = url.pathname.slice(basePath.length);
    const method = request.method.toUpperCase();

    switch (route) {
      case "/start":
        return method === "GET" ? start(url) : methodNotAllowed("GET");
      case "/complete":
        return method === "GET" ? complete(request, url) : methodNotAllowed("GET");
      case "/token":
        return method === "POST" ? token(request) : methodNotAllowed("POST");
      case "/logout":
        return method === "POST" ? logout(request) : methodNotAllowed("POST");
      case "/pairing":
        if (!pairingEnabled) return notFound();
        return method === "POST" ? pairing(request) : methodNotAllowed("POST");
      case "/pair":
        if (!pairingEnabled) return notFound();
        return method === "GET" || method === "POST"
          ? pair(request)
          : methodNotAllowed("GET, POST");
      default:
        return notFound();
    }
  };
}
