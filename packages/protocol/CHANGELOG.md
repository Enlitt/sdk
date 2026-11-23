# Changelog

All notable protocol changes are documented here.

## 0.1.1

- Added the per-application premium switch: the `premium_not_enabled` error code, `premium_enabled`
  on application views, and `validateBusinessApplicationPremiumRequest`.
- Added the premium cost profile's charge histogram (`PremiumUnitsHistogram`,
  `premiumUnitsHistogramBinCount`).
- Added the outreach visit contract (`POST`/`GET /v1/outreach/visits`).

## 0.1.0

First public release.

- Added the provider-neutral `EnlittStandardRequest`, premium-operation validators, API versioning,
  tolerant response parsing, a frozen error classifier, shared fixtures, and a generated
  cross-language contract.
- Added CLI authorization validators (`/v1/cli/*`, CLI authorization view, CLI credential list),
  the four device-flow error codes, `normalizeCliUserCode`, and the business key-list query validator.
