/**
 * `@enlitt/sdk/browser` — the entry point a business ships to its own users.
 *
 * This subpath must never import a secret key or a server-only module: it is
 * bundled and served to consumers. What it exposes is deliberately small —
 * two navigations and nothing else. There is no session accessor here,
 * because the session cookie is HttpOnly on the business's domain and no
 * browser code can read it; signed-in state is rendered from the business's
 * server through SDK-side routing.
 */

export { login, logout } from "./browser/auth.js";
export type { AuthNavigationOptions } from "./browser/auth.js";
