# Enlitt SDK

Source for Enlitt's client packages. Enlitt is one subscription that works across every AI app in
its network. These packages are what an app runs to route its users' AI calls through Enlitt.

Documentation: <https://enlitt.com/docs>

| Directory               | Package                                                                                                   | Install                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `packages/sdk`          | [`@enlitt/sdk`](https://www.npmjs.com/package/@enlitt/sdk)                                                | `npm install @enlitt/sdk`              |
| `packages/cli`          | [`@enlitt/cli`](https://www.npmjs.com/package/@enlitt/cli)                                                | `npx @enlitt/cli setup`                |
| `packages/protocol`     | [`@enlitt/protocol`](https://www.npmjs.com/package/@enlitt/protocol)                                      | installed with `@enlitt/sdk`           |
| `packages/sdk-python`   | [`enlitt`](https://pypi.org/project/enlitt/)                                                              | `pip install enlitt`                   |
| `packages/sdk-dotnet`   | [`Enlitt`, `Enlitt.AspNetCore`, `Enlitt.Extensions.AI`](https://www.nuget.org/packages/Enlitt.AspNetCore) | `dotnet add package Enlitt.AspNetCore` |
| `packages/unity-signin` | `com.enlitt.signin` (Unity Package Manager)                                                               | see below                              |

Unity: in **Window → Package Manager → + → Add package from git URL**, enter

```
https://github.com/enlitt/sdk.git?path=packages/unity-signin/upm
```

and pin a version by appending a tag, for example `#unity-signin-v0.1.0`.

## About this repository

This is a read-only mirror. The packages are developed in Enlitt's private repository and copied
here automatically on every change, so each commit here is one sync rather than the original
history. The mirror holds the package sources only, not the workspace that builds them; install
the published packages above to use them.

- Bugs and questions: [open an issue](https://github.com/enlitt/sdk/issues).
- Security problems: see [SECURITY.md](SECURITY.md). Please do not open a public issue.
- Pull requests are closed automatically; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
