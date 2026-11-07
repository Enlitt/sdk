/**
 * The CLI's own version, sent as `User-Agent: enlitt-cli/<version>` and printed
 * by `--version`. `src/version.test.ts` fails when this drifts from
 * `package.json`, so a release bump cannot forget it.
 */
export const CLI_VERSION = "0.1.0";
