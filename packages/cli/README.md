# `@enlitt/cli`

The terminal client for an Enlitt business account. It signs in to a business,
reads business and traffic facts, manages applications and API keys, writes a
project's environment file, and diagnoses an integration. It is built to be
driven by a coding agent: the agent never sees a password or a raw key unless
you ask for one.

## Install

```bash
npm i -D @enlitt/cli
npx enlitt --help
```

The CLI needs Node.js 22 or later and has no runtime dependencies.

## Sign in

```bash
npx enlitt login
```

The CLI prints a URL and a short code and opens your browser. Check that the
code matches, then approve while signed in to your business account.

Every command takes `--json` for one machine-readable document on stdout, and
`--env staging` to work against the staging deployment.

## Documentation

The full command reference, roles, and common tasks are at
https://enlitt.com/docs/cli.

## License

MIT
