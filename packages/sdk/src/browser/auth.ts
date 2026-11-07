/**
 * The browser-only entry to Enlitt login, and nothing beyond it.
 *
 * `login()` sends the visitor to the business's own login-start route and
 * `logout()` to the business's own logout route. Both are plain top-level
 * navigations to the business's own origin. This module holds no secret,
 * generates no verifier, performs no exchange, and never receives, reads,
 * stores, or exposes a session credential.
 *
 * There is deliberately no session accessor and no subscription here. The
 * session cookie is HttpOnly on the business's domain precisely so a
 * cross-site scripting flaw cannot read it, which also means this file cannot.
 * A browser API that appeared to return the session could only do so by
 * weakening that cookie or by inventing a second, readable copy of a
 * credential. Signed-in state is read on the business's server through
 * SDK-side routing's `getEnlittSession()` and rendered from there.
 *
 * Application login always resolves a personal account: this file names no
 * account type, carries no credential, and can present none, so a business
 * dashboard session has no path through here to become application access.
 */

/**
 * Where the business mounts the SDK's server-side handlers.
 *
 * These are the business's own routes on the business's own origin, matching
 * the mount point in `specs/Chatbot.md`. They are constants rather than
 * options because the spec fixes this entry point's surface at exactly
 * `login(options?)` and `logout(options?)`.
 */
const LOGIN_START_PATH = "/auth/login";
const LOGOUT_PATH = "/auth/logout";

/**
 * The query parameter carrying the post-flow destination. The server-side
 * handlers in `../server/callback.ts` read the same name and are the only
 * place the value is validated.
 */
const RETURN_TO_PARAM = "return_to";

export interface AuthNavigationOptions {
  /**
   * Where to send the visitor once the flow finishes.
   *
   * The value is passed through verbatim for the business's server to
   * validate against its own origin. Nothing here inspects, resolves, or
   * rewrites it: validation belongs on the server, and doing it twice in two
   * places is how the two copies drift apart.
   */
  readonly returnTo?: string;
}

/** The one thing this module needs from the browser. */
interface NavigationTarget {
  readonly href: string;
  assign(url: string): void;
}

function currentNavigationTarget(): NavigationTarget {
  const globalWindow = (globalThis as { window?: { location?: NavigationTarget } }).window;
  const target = globalWindow?.location;
  if (!target) {
    throw new Error(
      "@enlitt/sdk/browser: login() and logout() navigate the browser and can only " +
        "be called in a browser environment."
    );
  }
  return target;
}

function navigate(path: string, returnTo: string | undefined): void {
  const target = currentNavigationTarget();
  // `path` is one of this module's own constants, so the result is always on
  // the page's own origin no matter what the caller passed.
  const destination = new URL(path, target.href);
  if (returnTo !== undefined) {
    destination.searchParams.set(RETURN_TO_PARAM, returnTo);
  }
  target.assign(destination.toString());
}

/**
 * Send the visitor to the business's own login-start route.
 *
 * Returns nothing, because the call ends in a navigation and there is no
 * session for it to hand back.
 */
export function login(options?: AuthNavigationOptions): void {
  navigate(LOGIN_START_PATH, options?.returnTo);
}

/**
 * Send the visitor to the business's own logout route, which clears the
 * cookie and asks Enlitt to revoke the session server-side.
 */
export function logout(options?: AuthNavigationOptions): void {
  navigate(LOGOUT_PATH, options?.returnTo);
}
