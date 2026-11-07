/**
 * Shared fakes for the CLI tests: a temp-directory world, a scripted `fetch`,
 * a fixed clock with an instant `sleep`, and a scripted `git`. Nothing here
 * touches the network, a real git, or the real clock. Only tests import it.
 */
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BUSINESS_PERMISSIONS } from "@enlitt/protocol";
import type { BusinessPermission } from "@enlitt/protocol";

import { main } from "./main.js";
import type { CliContext, CliDeps } from "./main.js";
import { Output, SecretRegistry } from "./output.js";

/** The secret every containment test mints, so a leak is a plain substring search. */
export const SENTINEL_SECRET = "enl_test_SENTINELsecret0123456789abcdef";
export const SENTINEL_CLI_TOKEN = "enl_cli_SENTINELtoken0123456789abcdef";
export const SENTINEL_DEVICE_CODE = "devcode-SENTINEL-0123456789abcdef";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface ScriptedReply {
  readonly status: number;
  readonly body?: unknown;
}

export type Handler = (request: RecordedRequest) => ScriptedReply | undefined;

export interface GitFake {
  inWorkTree: boolean;
  tracked: Set<string>;
  ignored: Set<string>;
  /** When true, `git` behaves as if it is not installed. */
  missing: boolean;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The single JSON document on stdout, when there is one. */
  readonly json: unknown;
}

export interface World {
  readonly root: string;
  readonly project: string;
  readonly home: string;
  readonly config: string;
  readonly requests: RecordedRequest[];
  readonly sleeps: number[];
  readonly browser: string[];
  readonly git: GitFake;
  env: Record<string, string | undefined>;
  isTTY: { stdin: boolean; stdout: boolean; stderr: boolean };
  clock: Date;
  handler: Handler;
  /**
   * The `GET /v1/dashboard/business/access` answer used whenever `handler` does
   * not script one. Every business command reads it before its first request,
   * so tests get an owner unless they set another role with `accessBody(role)`.
   */
  access: Record<string, unknown>;
  /** All stdout and stderr this world has captured, for leak searches. */
  readonly captured: { stdout: string; stderr: string };
  deps(): CliDeps;
  run(argv: readonly string[]): Promise<RunResult>;
  /** Writes a file under the project and returns its path. */
  write(relative: string, contents: string): Promise<string>;
  read(relative: string): Promise<string>;
}

/** Creates a fresh world. `package.json` marks the project root. */
export async function makeWorld(): Promise<World> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enlitt-cli-")));
  const project = join(root, "project");
  const home = join(root, "home");
  const config = join(root, "config");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(project, "package.json"), "{}\n");

  const git: GitFake = { inWorkTree: true, tracked: new Set(), ignored: new Set(), missing: false };
  const captured = { stdout: "", stderr: "" };

  const world: World = {
    root,
    project,
    home,
    config,
    requests: [],
    sleeps: [],
    browser: [],
    git,
    env: { XDG_CONFIG_HOME: config },
    isTTY: { stdin: false, stdout: false, stderr: false },
    clock: new Date("2026-06-15T12:00:00Z"),
    handler: () => undefined,
    access: accessBody(),
    captured,
    deps(): CliDeps {
      return {
        fetch: (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(
            (init?.headers ?? {}) as Record<string, string>
          )) {
            headers[name.toLowerCase()] = value;
          }
          const rawBody = init?.body;
          const request: RecordedRequest = {
            method: init?.method ?? "GET",
            path: url.pathname,
            query: url.searchParams,
            headers,
            body: typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : undefined
          };
          world.requests.push(request);
          const scripted = world.handler(request);
          const reply =
            scripted ??
            (request.method === "GET" && request.path === "/v1/dashboard/business/access"
              ? { status: 200, body: world.access }
              : undefined);
          if (reply === undefined) {
            return Promise.reject(
              new Error(`unscripted request ${request.method} ${request.path}`)
            );
          }
          return Promise.resolve(
            new Response(
              reply.status === 204 || reply.body === undefined ? null : JSON.stringify(reply.body),
              {
                status: reply.status,
                headers: { "content-type": "application/json" }
              }
            )
          );
        },
        env: world.env,
        cwd: project,
        homedir: home,
        platform: "linux",
        hostname: "test-host",
        stdout: { write: (chunk) => (captured.stdout += chunk) },
        stderr: { write: (chunk) => (captured.stderr += chunk) },
        isTTY: world.isTTY,
        now: () => world.clock,
        sleep: (ms) => {
          world.sleeps.push(ms);
          return Promise.resolve();
        },
        openBrowser: (url) => {
          world.browser.push(url);
          return Promise.resolve();
        },
        git: async (args, cwd) => {
          if (git.missing) return { code: 127, stdout: "" };
          const path = args[args.length - 1] ?? "";
          if (args[0] === "rev-parse")
            return { code: git.inWorkTree ? 0 : 128, stdout: git.inWorkTree ? "true\n" : "" };
          if (args[0] === "ls-files") return { code: git.tracked.has(path) ? 0 : 1, stdout: "" };
          if (args[0] === "check-ignore") {
            const ignoreFile = await readFile(join(cwd, ".gitignore"), "utf8").catch(() => "");
            const listed = ignoreFile.split("\n").includes(`/${path}`);
            return { code: git.ignored.has(path) || listed ? 0 : 1, stdout: "" };
          }
          return { code: 1, stdout: "" };
        }
      };
    },
    async run(argv) {
      captured.stdout = "";
      captured.stderr = "";
      const code = await main(argv, world.deps());
      let json: unknown;
      try {
        json = JSON.parse(captured.stdout);
      } catch {
        json = undefined;
      }
      return { code, stdout: captured.stdout, stderr: captured.stderr, json };
    },
    async write(relative, contents) {
      const path = join(project, relative);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, contents);
      return path;
    },
    read: (relative) => readFile(join(project, relative), "utf8")
  };
  return world;
}

// ---------------------------------------------------------------------------
// Wire fixtures. Shapes follow packages/protocol; values are invented.
// ---------------------------------------------------------------------------

export const BUSINESS = { id: "biz_1", name: "Acme Games" };

export function keyMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "key_1",
    name: "web",
    prefix: "enl_test_SENTINEL",
    scope: "model",
    application_id: "app_1",
    environment: "test",
    status: "active",
    created_at: "2026-06-01T00:00:00Z",
    expires_at: null,
    last_used_at: null,
    ...overrides
  };
}

export function usage(): Record<string, unknown> {
  return {
    standard: { requests: 3, used_nano_usd: "1000" },
    premium: { requests: 2, used_nano_usd: "5000000000", earnings_nano_usd: "2500000000" }
  };
}

export function appSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "app_1",
    name: "Web",
    environment: "test",
    status: "active",
    client_id: "enl_client_abc",
    created_at: "2026-10-01T00:00:00.000Z",
    api_keys: [keyMetadata()],
    daily_visitors: [],
    visitors: 0,
    usage: usage(),
    ...overrides
  };
}

export function appDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "app_1",
    client_id: "enl_client_abc",
    name: "Web",
    environment: "test",
    status: "active",
    premium_enabled: true,
    info: null,
    redirect_uris: ["https://app.example.com/callback"],
    allowed_origins: ["https://app.example.com"],
    created_at: "2026-06-01T00:00:00Z",
    analytics: {
      range: { from: "2026-06-01T00:00:00Z", to: "2026-06-16T00:00:00Z", timezone: "UTC" },
      days: [],
      next_cursor: null
    },
    api_keys: [keyMetadata()],
    ...overrides
  };
}

export function businessInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    business: BUSINESS,
    earnings: {
      earnings_nano_usd: "2500000000",
      payout_pending_nano_usd: "0",
      display_currency: "USD"
    },
    payout: {
      eligible: false,
      connected_account_status: "none",
      policy_code_version: "2026-09-29",
      minimum_available_nano_usd: "50000000000",
      next_eligible_at: null,
      blocked_reason: "below_minimum"
    },
    traffic: { daily_visitors: [], daily_usage: [], usage: usage() },
    applications: [appSummary()],
    next_cursor: null,
    range: { from: "2026-05-17T00:00:00Z", to: "2026-06-16T00:00:00Z", timezone: "UTC" },
    data_fresh_at: "2026-06-15T11:59:00Z",
    ...overrides
  };
}

/** The business roles a fixture can sign in as (wire vocabulary: `BUSINESS_ROLE_NAMES`). */
export type FixtureRole = "owner" | "admin" | "developer" | "viewer";

/**
 * What each role holds, as `specs/Account.md` defines the registry. The registry
 * itself lives in the backend (`BUSINESS_ROLES`), which the CLI must not import,
 * so this is a fixture copy: `owner` is the protocol's full permission list and
 * the others are the registry's entries. The CLI reads only the resolved
 * `permissions` array, so a registry change needs no CLI change.
 */
export const ROLE_PERMISSIONS: Readonly<Record<FixtureRole, readonly BusinessPermission[]>> = {
  owner: BUSINESS_PERMISSIONS,
  admin: inDeclaredOrder(["apps.manage", "members.manage", "premium.manage", "stats.view"]),
  developer: inDeclaredOrder(["apps.manage", "stats.view"]),
  viewer: inDeclaredOrder(["stats.view"])
};

/** The wire carries `permissions` in the protocol's declared order, so fixtures must too. */
function inDeclaredOrder(held: readonly BusinessPermission[]): BusinessPermission[] {
  return BUSINESS_PERMISSIONS.filter((permission) => held.includes(permission));
}

/** A `BusinessAccess` body for the active business as `role`. */
export function accessBody(role: FixtureRole = "owner"): Record<string, unknown> {
  return {
    login: { email: "dev@example.com" },
    owns_business: role === "owner",
    active_business: {
      ...BUSINESS,
      created_at: "2026-01-01T00:00:00Z",
      role,
      permissions: [...ROLE_PERMISSIONS[role]]
    },
    businesses: [{ ...BUSINESS, role, status: "active" }],
    pending_invitations: []
  };
}

export function errorBody(
  code: string,
  message = "Refused."
): { error: { code: string; message: string }; request_id: string } {
  return { error: { code, message }, request_id: "req_test" };
}

/** Writes a valid credential file for `world`'s environment (production by default). */
export async function loginAs(
  world: World,
  token = SENTINEL_CLI_TOKEN,
  expiresAt = "2027-01-01T00:00:00Z",
  environment: "production" | "staging" = "production"
): Promise<void> {
  const directory = join(world.config, "enlitt");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, `cli-${environment}.json`),
    `${JSON.stringify({
      version: 1,
      api_origin:
        environment === "production" ? "https://api.enlitt.com" : "https://staging-api.enlitt.com",
      token,
      credential_id: "cred_1",
      business: BUSINESS,
      login_email: "dev@example.com",
      token_expires_at: expiresAt
    })}\n`,
    { mode: 0o600 }
  );
}

/** The CLI-admitted routes answered with the standard fixtures (access comes from `world.access`). */
export function standardRoutes(extra: Handler = () => undefined): Handler {
  return (request) => {
    const given = extra(request);
    if (given !== undefined) return given;
    const { method, path } = request;
    // The access read is answered by `world.access` when no handler scripts it.
    if (method === "GET" && path === "/v1/dashboard/business")
      return { status: 200, body: businessInfo() };
    if (method === "GET" && path === "/v1/dashboard/business/applications/app_1")
      return { status: 200, body: appDetail() };
    return undefined;
  };
}

/** Requests that changed state. */
export function mutations(world: World): RecordedRequest[] {
  return world.requests.filter((request) => request.method !== "GET");
}

/** A command context over `world` for tests that call library modules directly. */
export function contextFor(
  world: World,
  options: { json?: boolean; env?: "production" | "staging" } = {}
): CliContext {
  const deps = world.deps();
  const secrets = new SecretRegistry();
  const environment = options.env ?? "production";
  return {
    deps,
    env: environment,
    apiOrigin:
      environment === "production" ? "https://api.enlitt.com" : "https://staging-api.enlitt.com",
    json: options.json ?? false,
    out: new Output(deps, options.json ?? false, secrets, environment),
    secrets
  };
}
