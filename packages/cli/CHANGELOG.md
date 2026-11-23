# Changelog

## 0.1.1

- `enlitt app premium [<id>] (--on | --off) [--confirm]` turns an application's premium credit on or
  off (`--off` on a live application needs `--confirm`); `app show` prints `premium_enabled`; a
  `premium_not_enabled` refusal prints its next step.

- `setup` detects the project's language from its root (`package.json` → Node,
  `pyproject.toml` or `requirements.txt` → Python, `*.csproj` or `*.sln` → .NET) and uses it to
  pick the default env file (`.env.local` for Node, `.env` otherwise) and the docs page it points to.
  An explicit `--env-file` or a linked project still wins.

## 0.1.0

- First public release: device-flow sign-in and step-up approval, business and traffic reads,
  application and API key management, environment-file wiring, and `doctor` integration checks.
