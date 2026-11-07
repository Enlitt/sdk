# Changelog

## Unreleased

- `enlitt app premium [<id>] (--on | --off) [--confirm]` turns an application's premium credit on or
  off (`--off` on a live application needs `--confirm`); `app show` prints `premium_enabled`; a
  `premium_not_enabled` refusal prints its next step.

## 0.1.0

- First public release: device-flow sign-in and step-up approval, business and traffic reads,
  application and API key management, environment-file wiring, and `doctor` integration checks.
