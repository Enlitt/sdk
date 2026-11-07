# `@enlitt/protocol`

Versioned runtime schemas and transport-level types shared by the Enlitt backend and SDK.

This package is framework-neutral. It contains the strict request validators, strict/tolerant
response readers, stable errors, streaming events, shared wire fixtures, and compatibility rules,
but no application or database behavior.

The generated cross-language contract is published as `@enlitt/protocol/contract.json`. Run
`pnpm --filter @enlitt/protocol generate:contract` after changing a protocol constant or closed set.

`validateAuthorizationExchangeResponse()` validates the login exchange's opaque
`session_token` and application-scoped stable `subject`. Servers emit the strict
shape; SDK callbacks read with `{ mode: "tolerant" }` so future response fields
do not interrupt login. A subject links an application's own user records and
is never accepted as a credential or model-request identity.
