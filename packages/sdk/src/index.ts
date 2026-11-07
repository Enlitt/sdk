/**
 * `@enlitt/sdk` — the isomorphic entry point.
 *
 * Only declarations that are safe in both a browser bundle and a server
 * runtime belong here. Anything that reads a secret lives behind
 * `@enlitt/sdk/server`; anything that touches `window` lives behind
 * `@enlitt/sdk/browser`. `docs/ARCHITECTURE.md` keeps that split, and the
 * `browser` export condition in `package.json` enforces it at bundle time.
 *
 * Account contributes nothing here on purpose. Its browser half is a pair of
 * navigations that only make sense in a browser, and its server half handles
 * the business secret; a session type exported from here would be the first
 * step towards a browser-readable session, which is exactly what the HttpOnly
 * cookie exists to prevent.
 */

export {};
