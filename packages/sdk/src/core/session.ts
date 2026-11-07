/**
 * The read end of the Enlitt session cookie.
 *
 * `specs/SDK-side routing.md` gives this file the session handle, the
 * middleware, and the async-context accessors. It owns "the user logs in and
 * their credits are just used": it carries Enlitt's opaque session token from
 * the cookie Account's login callback already set, through an
 * `AsyncLocalStorage` context, to whatever call site needs it, without ever
 * reading, parsing, or validating what the token contains. Validity is
 * Enlitt's answer to give at call time, not this file's to guess.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { EnlittConfigurationError } from "./errors.js";

/**
 * The canonical Enlitt session cookie name, and the default of both
 * `CallbackConfig.cookieName` and `SessionMiddlewareOptions.cookieName`.
 *
 * A business that passes a custom `cookieName` to the callback must pass the
 * identical value to the middleware. That is the one case the two ends can
 * still disagree, and it is the business's own to keep consistent; the default
 * is not, which is why it is one constant rather than two literals.
 */
export const ENLITT_SESSION_COOKIE_NAME = "enlitt_session";

/**
 * The request header that carries a session token from a game or native client
 * with no cookie jar. Account's "Client sign-in handoff" gives the client the
 * token, and the client sends it here on every request to the business backend.
 * `enlittSessionMiddleware()` reads it only when `header: true` is passed.
 */
export const ENLITT_SESSION_HEADER_NAME = "Enlitt-Session";

/**
 * The longest token value `enlittSession()` accepts.
 *
 * Not a claim about Enlitt's actual token format, which this module never
 * inspects: it exists only so a business's own bug (an empty string, or
 * something that is clearly not a token, such as a whole cookie header pasted
 * in whole) fails at construction instead of being carried silently to a call
 * Enlitt then refuses for a reason the caller cannot see locally.
 */
const MAX_SESSION_TOKEN_LENGTH = 4096;

/**
 * An opaque handle around Enlitt's session token.
 *
 * The token has no subject, expiry, or scope readable from the SDK side, and
 * every fact about the user lives on Enlitt's servers. Deliberately just a
 * string wrapper: exposing it as a bare `string` anywhere in the call surface
 * would invite a business to construct or compare tokens as ordinary strings,
 * and there is no format a business can legitimately synthesize.
 */
export interface EnlittSession {
  readonly token: string;
}

/**
 * The only way to construct an `EnlittSession`.
 *
 * The token is a string the SDK never parses, decodes, validates, or
 * inspects; this is what lets Enlitt rotate or restructure the underlying
 * credential without a business shipping a release, and what keeps the
 * business from ever holding an OAuth token or implementing a refresh.
 * Constructing one from a value a business stored itself is legitimate and is
 * how linked accounts and background jobs work; constructing one from a value
 * the business derived, guessed, or built from a user identifier is not a
 * session, and Enlitt rejects it at call time. The factory validates only
 * that the token is a non-empty bounded string, because anything more would
 * be inspecting a credential this module must treat as opaque.
 */
export function enlittSession(token: string): EnlittSession {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_SESSION_TOKEN_LENGTH) {
    throw new EnlittConfigurationError(
      "enlittSession() requires a non-empty session token no longer than " +
        `${MAX_SESSION_TOKEN_LENGTH} characters.`
    );
  }
  return { token };
}

/**
 * Options for `enlittSessionMiddleware()`.
 *
 * `cookieName` exists solely to mirror a business's own custom
 * `CallbackConfig.cookieName`; the default matches `ENLITT_SESSION_COOKIE_NAME`
 * so the common case names nothing.
 *
 * `header` opts in to the `Enlitt-Session` header as the session source for
 * clients without a cookie jar. It defaults to `false` so a browser-only
 * business never accepts a token from a header it does not expect. The header
 * is a bearer credential like the cookie: serve these routes over https and
 * keep it out of logs. It is not CSRF-relevant, since a browser never attaches
 * it on its own.
 */
export interface SessionMiddlewareOptions {
  cookieName?: string;
  header?: boolean;
}

/**
 * The shape `enlittSessionMiddleware()` returns.
 *
 * Framework-agnostic over Web `Request` and `Response`, exactly as Account's
 * callback handlers are: v1 ships no per-framework adapter, so this is the
 * one shape every framework's own middleware layer can wrap.
 */
export type EnlittMiddleware = (
  request: Request,
  next: () => Promise<Response>
) => Promise<Response>;

/**
 * The single `AsyncLocalStorage` context carrying the current request's
 * session.
 *
 * Not exported: the module boundary between "install the context" and "read
 * the context" is what lets `getEnlittSession()` distinguish a missing
 * middleware from a signed-out visitor by whether a context exists at all,
 * a distinction that leaks the moment callers can reach the storage directly.
 */
const sessionContext = new AsyncLocalStorage<EnlittSession | null>();

/**
 * Reads the Enlitt session cookie from an incoming request, runs `next()`
 * with an `AsyncLocalStorage` context carrying the resulting `EnlittSession`
 * or an explicit `null`, and leaves the context when the request ends.
 *
 * It never rejects a request: plenty of a business's routes are for
 * signed-out visitors, and deciding the business's authentication policy is
 * not this middleware's job. It performs no network call and no validation,
 * because validity is Enlitt's answer to give at call time and pre-validating
 * here would add a round trip to every request, including the ones that never
 * call a model. The cookie lives on the business's own domain and was set by
 * Enlitt's login callback, so no cross-site cookie, third-party storage, or
 * browser-side token is involved.
 */
export function enlittSessionMiddleware(options?: SessionMiddlewareOptions): EnlittMiddleware {
  const cookieName = options?.cookieName ?? ENLITT_SESSION_COOKIE_NAME;
  const useHeader = options?.header === true;
  return async function enlittMiddleware(
    request: Request,
    next: () => Promise<Response>
  ): Promise<Response> {
    // With `header: true` a non-empty header is the session and the cookie is
    // read only when the header is absent or empty.
    const headerToken = useHeader ? request.headers.get(ENLITT_SESSION_HEADER_NAME) : null;
    const token =
      headerToken !== null && headerToken !== "" ? headerToken : readCookie(request, cookieName);
    // A token that fails `enlittSession()`'s bound check (an over-long header
    // or cookie) gives a null context: the middleware never rejects a request.
    let session: EnlittSession | null = null;
    if (token !== null) {
      try {
        session = enlittSession(token);
      } catch {
        session = null;
      }
    }
    return sessionContext.run(session, next);
  };
}

/**
 * Runs `fn` with an explicit `EnlittSession` (or `null`) bound as the ambient
 * session for its entire synchronous and asynchronous extent.
 *
 * The escape hatch for a framework whose middleware shape
 * `enlittSessionMiddleware()` cannot wrap directly: a business on such a
 * framework establishes the same context in one line instead of waiting on a
 * per-framework adapter that v1 does not ship.
 */
export function runWithEnlittSession<T>(session: EnlittSession | null, fn: () => T): T {
  return sessionContext.run(session, fn);
}

/**
 * Returns the ambient session for the current request context.
 *
 * Throws `EnlittConfigurationError` when there is no context at all: no
 * context means the middleware is not installed on this path, which is the
 * business's own wiring bug, and treating that as "signed out" would make
 * every user of a misconfigured deployment silently unauthenticated. Returns
 * `null` when there is a context and no session, which is the genuine
 * signed-out state a business checks before calling a model. These two
 * conditions must never collapse into one: a deployment bug and a
 * signed-out visitor look identical at the call site and must not be
 * reported identically. A session this returns may still be expired or
 * revoked; that is not knowable locally, so the call carries it and Enlitt
 * answers with `personal_login_required` if it must.
 */
export function getEnlittSession(): EnlittSession | null {
  if (!hasEnlittSessionContext()) {
    throw new EnlittConfigurationError(
      "getEnlittSession() was called with no enlittSessionMiddleware() (or " +
        "runWithEnlittSession()) context installed on this request path."
    );
  }
  return sessionContext.getStore() ?? null;
}

/**
 * Distinguishes "no `AsyncLocalStorage` context at all" from "a context
 * holding `null`", which reading `getStore()` alone cannot do since both
 * would otherwise read back as a nullish value.
 *
 * Relies on `AsyncLocalStorage`'s own documented signal: `getStore()` returns
 * `undefined` when no `run()` scope is active, and returns the exact value
 * (including `null`) passed to the innermost active `run()` otherwise. So the
 * presence of a context is `getStore() !== undefined`, given this module
 * never stores `undefined` itself — only an `EnlittSession` or `null`.
 */
function hasEnlittSessionContext(): boolean {
  return sessionContext.getStore() !== undefined;
}

/**
 * Parses the named cookie out of a Web `Request`'s `Cookie` header.
 *
 * Deliberately minimal: this reads one opaque value off the business's own
 * domain and never interprets it, so it need not implement the full cookie
 * grammar, only enough to split `name=value` pairs safely.
 */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) {
    return null;
  }
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const rawName = part.slice(0, separatorIndex).trim();
    if (rawName !== name) {
      continue;
    }
    const rawValue = part.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return null;
}
