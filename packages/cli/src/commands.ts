/**
 * The complete command surface of the CLI (`specs/SDK-side routing.md`
 * "commands.ts"). Each command is a `CommandSpec` plus a handler that takes the
 * parsed flags and the run context and returns the exit code.
 *
 * Rules every handler follows:
 * - validate flags and destinations before the first request, so a refusal
 *   never leaves a half-done effect;
 * - a raw key leaves memory only through `env-file.ts` (or `--reveal`);
 * - every destructive action is gated by `--confirm`, never by a prompt.
 */
import {
  API_KEY_SCOPE_LABELS,
  ENLITT_ERROR_CODE,
  UNKNOWN_API_KEY_SCOPE_LABEL
} from "@enlitt/protocol";
import type {
  ApiKeyMetadata,
  BusinessAccessActiveBusiness,
  BusinessPermission,
  BusinessApplicationDetail,
  BusinessApplicationSummary,
  BusinessDashboardInfo,
  CreateBusinessKeyResponse
} from "@enlitt/protocol";

import type { CommandSpec, FlagDoc, FlagKind, ParsedArgs } from "./args.js";
import { createDashboardClient, EnlittDashboardError } from "./client.js";
import type { DashboardClient, ReadQuery } from "./client.js";
import {
  deleteCredential,
  loadCredential,
  requireCredential,
  saveCredential
} from "./credentials.js";
import type { StoredCredential } from "./credentials.js";
import { runDeviceFlow } from "./device-flow.js";
import type { DeviceFlowKind } from "./device-flow.js";
import { runDoctor, CLIENT_ID_VARIABLE, SECRET_KEY_VARIABLE } from "./doctor.js";
import { checkEnvTarget, readEnvPresence, upsertEnvValue } from "./env-file.js";
import type { CliContext, CliEnvironment } from "./main.js";
import {
  CliError,
  formatRows,
  formatUsd,
  permissionRefusal,
  siteOrigin,
  usageError
} from "./output.js";
import {
  DEFAULT_ENV_FILE,
  PROJECT_FILE_NAME,
  defaultEnvFileFor,
  detectLanguage,
  findProjectRoot,
  readProject,
  writeProject
} from "./project.js";
import type { ProjectFile } from "./project.js";
import { eachDay, resolveOptionalRange, resolveTrafficRange } from "./traffic.js";
import type { DayRange } from "./traffic.js";

/** A command definition: what the tokenizer needs, plus the handler. */
export interface Command extends CommandSpec {
  readonly run: (args: ParsedArgs, ctx: CliContext) => Promise<number>;
}

const REPORTING_KEY_VARIABLE = "ENLITT_REPORTING_KEY";
/**
 * The business dashboard for the selected `--env` (`docs/ENVIRONMENTS.md`: the
 * website is `https://enlitt.com` in production and `https://staging.enlitt.com`
 * in staging). Named in hints for the actions the CLI deliberately cannot perform.
 */
function dashboardUrl(env: CliEnvironment): string {
  return `${siteOrigin(env)}/dashboard/business`;
}
/** A defensive bound on cursor loops, far above any real business. */
const MAX_PAGES = 1_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Reads a required value flag or raises a `usage_error` naming it. */
function requireValue(args: ParsedArgs, name: string): string {
  const value = args.value(name);
  if (value === undefined || value === "") throw usageError(`--${name} is required`);
  return value;
}

function defaultLabel(ctx: CliContext): string {
  return `${ctx.deps.hostname} (${ctx.deps.platform})`;
}

/** The browser opens unless `--no-browser`, `CI`, or `BROWSER=none` says otherwise. */
function browserAllowed(ctx: CliContext, noBrowserFlag: boolean): boolean {
  const { CI, BROWSER } = ctx.deps.env;
  return !noBrowserFlag && (CI === undefined || CI === "") && BROWSER !== "none";
}

function parseTimeoutMs(args: ParsedArgs): number | undefined {
  const text = args.value("timeout");
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text) || Number(text) < 1)
    throw usageError("--timeout must be a whole number of seconds");
  return Number(text) * 1_000;
}

/**
 * The permission each gated command needs, in the order `whoami` lists them
 * (`specs/SDK-side routing.md` "Roles and the local permission check"). Values
 * are permission names from `@enlitt/protocol`, never role names, and no code
 * in this package compares a role name. Commands that need nothing beyond a
 * credential (`login`, `reauth`, `logout`, `whoami`, `status`, `doctor`) are
 * not listed.
 *
 * `setup` is listed at its baseline, `stats.view`: it needs `apps.manage` only
 * when it creates the application, and `keys.manage` only for its key step,
 * which it skips without it.
 */
export const COMMAND_PERMISSIONS: Readonly<Record<string, BusinessPermission>> = {
  "business info": "stats.view",
  traffic: "stats.view",
  "app list": "stats.view",
  "app show": "stats.view",
  "key list": "stats.view",
  "app create": "apps.manage",
  "app update": "apps.manage",
  "app premium": "premium.manage",
  "key create": "keys.manage",
  "key rotate": "keys.manage",
  "key revoke": "keys.manage",
  "key list --scope read-only": "keys.manage",
  setup: "stats.view"
};

/** The command names (and the rest) that `permissions` satisfy, in table order. */
function commandsFor(permissions: readonly string[]): { allowed: string[]; denied: string[] } {
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const [command, needs] of Object.entries(COMMAND_PERMISSIONS)) {
    (permissions.includes(needs) ? allowed : denied).push(command);
  }
  return { allowed, denied };
}

/**
 * What the last permission check of a run knew, so a server
 * `insufficient_permissions` on the same run can be explained with the same
 * wording (the role could have changed between the check and the request).
 */
const checkedAccess = new WeakMap<
  CliContext,
  { needs: BusinessPermission; role: string; business: string }
>();

/**
 * Loads the credential and builds a client for it. With `needs`, it first reads
 * `GET /v1/dashboard/business/access` (never cached, so a role change applies
 * on the next command) and refuses with `insufficient_permissions` before any
 * other request when the login's permissions in this business lack `needs`.
 * The server stays the authority; this only refuses earlier and more clearly.
 */
async function session(
  ctx: CliContext,
  needs: BusinessPermission | null
): Promise<{
  credential: StoredCredential;
  client: DashboardClient;
  business: BusinessAccessActiveBusiness | null;
}> {
  const credential = await requireCredential(ctx);
  const client = createDashboardClient(ctx, credential);
  if (needs === null) return { credential, client, business: null };
  const business = (await client.access()).active_business;
  if (business === null) {
    throw new CliError(
      ENLITT_ERROR_CODE.business_selection_required,
      "No business is active for this credential."
    );
  }
  checkedAccess.set(ctx, { needs, role: business.role, business: business.name });
  if (!business.permissions.includes(needs)) throw refusalFor(needs, business.role, business.name);
  return { credential, client, business };
}

/** The `insufficient_permissions` error for a missing permission, with its role-aware text. */
function refusalFor(needs: string, role: string, business: string): CliError {
  const { message, action } = permissionRefusal(needs, role, business);
  return new CliError(
    ENLITT_ERROR_CODE.insufficient_permissions,
    message,
    action === undefined ? {} : { action }
  );
}

/**
 * Wraps a handler so a server `insufficient_permissions` renders like the local
 * check when the CLI knows what the command needed. The code stays the server's.
 */
function explainingRoleRefusals(command: Command): Command {
  return {
    ...command,
    run: async (args, ctx) => {
      try {
        return await command.run(args, ctx);
      } catch (error) {
        const known = checkedAccess.get(ctx);
        if (
          known !== undefined &&
          error instanceof CliError &&
          error.code === ENLITT_ERROR_CODE.insufficient_permissions
        ) {
          // A permission without its own wording keeps the server's message.
          const explained = refusalFor(known.needs, known.role, known.business);
          throw explained.action === undefined ? error : explained;
        }
        throw error;
      }
    }
  };
}

/**
 * Runs `run`, and on `reauthentication_required` runs a step-up approval inline
 * and retries once, but only when a person is at the terminal. Otherwise the
 * refusal propagates with its documented action, so an agent runs `reauth`.
 */
async function withStepUp<T>(ctx: CliContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const interactive = ctx.deps.isTTY.stdin && ctx.deps.isTTY.stderr;
    if (
      !(error instanceof CliError) ||
      error.code !== ENLITT_ERROR_CODE.reauthentication_required ||
      !interactive
    )
      throw error;
    ctx.out.progress("This needs a fresh approval.");
    await runDeviceFlow(
      "step_up",
      { label: defaultLabel(ctx), wait: "now", openBrowser: browserAllowed(ctx, false) },
      ctx
    );
    return run();
  }
}

/** Requires `--confirm`, or refuses before any request. */
function requireConfirm(args: ParsedArgs, what: string): void {
  if (!args.bool("confirm")) {
    throw new CliError("confirmation_required", `${what} needs the developer's confirmation.`);
  }
}

/** A detail without its `analytics` window, which is `traffic`'s job. */
function withoutAnalytics(detail: BusinessApplicationDetail): Record<string, unknown> {
  return Object.fromEntries(Object.entries(detail).filter(([name]) => name !== "analytics"));
}

/** Every application summary of the business, following `next_cursor`. */
async function allApplications(
  client: DashboardClient,
  query: ReadQuery = {}
): Promise<{ first: BusinessDashboardInfo; applications: BusinessApplicationSummary[] }> {
  const first = await client.business(query);
  const applications = [...first.applications];
  let cursor = first.next_cursor;
  for (let page = 0; cursor !== null && page < MAX_PAGES; page += 1) {
    const next = await client.business({ from: first.range.from, to: first.range.to, cursor });
    applications.push(...next.applications);
    cursor = next.next_cursor;
  }
  return { first, applications };
}

function activeKeyCount(keys: readonly ApiKeyMetadata[]): number {
  return keys.filter((key) => key.status === "active").length;
}

/** The linked application's ID, or `project_not_linked`. */
async function applicationIdOrLinked(
  ctx: CliContext,
  positional: string | undefined
): Promise<string> {
  if (positional !== undefined) return positional;
  const project = await readProject(ctx);
  if (project === null) {
    throw new CliError("project_not_linked", "This project is not linked to an application.");
  }
  return project.applicationId;
}

// ---------------------------------------------------------------------------
// login, reauth, logout, whoami, status
// ---------------------------------------------------------------------------

const AUTH_FLAGS: Readonly<Record<string, FlagKind>> = {
  "no-browser": "bool",
  "no-wait": "bool",
  wait: "bool",
  timeout: "value"
};

async function authFlow(kind: DeviceFlowKind, args: ParsedArgs, ctx: CliContext): Promise<number> {
  if (args.bool("no-wait") && args.bool("wait"))
    throw usageError("--no-wait and --wait cannot be used together");
  const wait = args.bool("no-wait") ? "start_only" : args.bool("wait") ? "resume" : "now";
  const timeoutMs = parseTimeoutMs(args);
  const result = await runDeviceFlow(
    kind,
    {
      label: args.value("label") ?? defaultLabel(ctx),
      wait,
      openBrowser: browserAllowed(ctx, args.bool("no-browser")),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    },
    ctx
  );

  if ("status" in result) {
    const command = kind === "login" ? "login" : "reauth";
    if (ctx.json) {
      ctx.out.result(result, "");
    } else {
      // The device flow already printed the URL and code on stderr; stdout stays empty
      // and only the next step is added, so the code appears exactly once.
      ctx.out.progress(`Ask the developer to approve it, then run \`enlitt ${command} --wait\`.`);
    }
    return 0;
  }

  if (result.kind === "step_up") {
    ctx.out.result(
      { reauthenticated_at: result.reauthenticated_at },
      `Approved at ${result.reauthenticated_at}.`
    );
    return 0;
  }

  // A login grant is written before anything is printed.
  const previous = await loadCredential(ctx).catch(() => null);
  await saveCredential(ctx, {
    version: 1,
    api_origin: ctx.apiOrigin,
    token: result.token,
    credential_id: result.credential_id,
    business: result.business,
    login_email: result.login.email,
    token_expires_at: result.token_expires_at
  });
  if (previous !== null) {
    try {
      await createDashboardClient(ctx, previous).revokeCredential();
    } catch {
      // Best effort: the replaced credential also expires on its own.
    }
  }
  ctx.out.result(
    {
      login: { email: result.login.email },
      business: result.business,
      credential_id: result.credential_id,
      expires_at: result.token_expires_at
    },
    `Logged in as ${result.login.email} to ${result.business.name} (${result.business.id}). Credential expires ${result.token_expires_at}.`
  );
  return 0;
}

/** The `whoami` document, shared with `status`. */
async function identity(ctx: CliContext, credential: StoredCredential, client: DashboardClient) {
  const access = await client.access();
  const business = access.active_business;
  if (business === null) {
    throw new CliError(
      ENLITT_ERROR_CODE.business_selection_required,
      "No business is active for this credential."
    );
  }
  return {
    login: { email: access.login.email },
    business: {
      id: business.id,
      name: business.name,
      role: business.role,
      permissions: business.permissions,
      allowed_commands: commandsFor(business.permissions).allowed
    },
    environment: ctx.env,
    api_origin: ctx.apiOrigin,
    credential_expires_at: credential.token_expires_at
  };
}

/** The "You can run" and "Not with your role" lines shared by `whoami` and `status`. */
function allowedCommandsText(business: { permissions: readonly string[] }): string[] {
  const { allowed, denied } = commandsFor(business.permissions);
  return [
    `You can run: ${allowed.join(", ") || "(nothing gated)"}`,
    ...(denied.length === 0 ? [] : [`Not with your role: ${denied.join(", ")}`])
  ];
}

function identityText(document: Awaited<ReturnType<typeof identity>>): string {
  return [
    formatRows([
      ["login", document.login.email],
      ["business", `${document.business.name} (${document.business.id})`],
      ["role", document.business.role],
      ["permissions", document.business.permissions.join(", ")],
      ["environment", `${document.environment} (${document.api_origin})`],
      ["credential expires", document.credential_expires_at]
    ]),
    ...allowedCommandsText(document.business)
  ].join("\n");
}

async function runStatus(ctx: CliContext): Promise<number> {
  const credential = await loadCredential(ctx);
  let who: Awaited<ReturnType<typeof identity>> | undefined;
  if (credential !== null) {
    try {
      who = await identity(ctx, credential, createDashboardClient(ctx, credential));
    } catch (error) {
      const refused =
        error instanceof CliError &&
        ["not_logged_in", ENLITT_ERROR_CODE.dashboard_login_required].includes(error.code);
      if (!refused) throw error;
    }
  }
  const project = await readProject(ctx);
  const names = [SECRET_KEY_VARIABLE, CLIENT_ID_VARIABLE];
  const presence = project === null ? null : await readEnvPresence(ctx, project.envFile, names);
  const document = {
    logged_in: who !== undefined,
    ...(who === undefined ? {} : { login: who.login, business: who.business }),
    project: {
      linked: project !== null,
      ...(project === null
        ? {}
        : { application_id: project.applicationId, env_file: project.envFile }),
      env_file_has: {
        ENLITT_SECRET_KEY: presence?.[SECRET_KEY_VARIABLE] ?? false,
        ENLITT_CLIENT_ID: presence?.[CLIENT_ID_VARIABLE] ?? false
      }
    }
  };
  const rows: (readonly [string, string])[] = [
    [
      "logged in",
      who === undefined ? "no (run `enlitt login`)" : `${who.login.email}, ${who.business.name}`
    ],
    ["project", project === null ? "not linked" : `${project.applicationId} (${project.envFile})`]
  ];
  if (project !== null) {
    rows.push([
      "env file has",
      `${SECRET_KEY_VARIABLE}: ${String(document.project.env_file_has.ENLITT_SECRET_KEY)}, ${CLIENT_ID_VARIABLE}: ${String(document.project.env_file_has.ENLITT_CLIENT_ID)}`
    ]);
  }
  ctx.out.result(
    document,
    [formatRows(rows), ...(who === undefined ? [] : allowedCommandsText(who.business))].join("\n")
  );
  return 0;
}

// ---------------------------------------------------------------------------
// business info, traffic
// ---------------------------------------------------------------------------

const BLOCKED_REASON_WORDS: Readonly<Record<string, string>> = {
  payout_blocked: "payouts are blocked for this business",
  below_minimum: "the available balance is below the minimum",
  outstanding_deficit: "there is an outstanding deficit",
  tax_details_required: "tax details are required",
  payout_account_incomplete: "the payout account setup is incomplete",
  monthly_payout_taken: "this month's payout was already taken",
  payout_pending: "a payout is already pending"
};

async function runBusinessInfo(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const range = resolveOptionalRange(
    { from: args.value("from"), to: args.value("to") },
    ctx.deps.now()
  );
  const { client } = await session(ctx, "stats.view");
  const { first, applications } = await allApplications(
    client,
    range === undefined ? {} : { from: range.from, to: range.to }
  );
  const document = {
    business: first.business,
    earnings: first.earnings,
    payout: first.payout,
    traffic: { usage: first.traffic.usage },
    range: first.range,
    data_fresh_at: first.data_fresh_at,
    application_count: applications.length
  };

  const payout = first.payout;
  let payoutText = "eligible";
  if (!payout.eligible) {
    const reason =
      payout.blocked_reason === undefined
        ? "not eligible"
        : (BLOCKED_REASON_WORDS[payout.blocked_reason] ??
          payout.blocked_reason.replaceAll("_", " "));
    payoutText = `not eligible, because ${reason}${payout.next_eligible_at === null ? "" : `; next eligible ${payout.next_eligible_at}`}`;
  }
  const usage = first.traffic.usage;
  ctx.out.result(
    document,
    [
      formatRows([
        ["business", `${first.business.name} (${first.business.id})`],
        ["earnings", formatUsd(first.earnings.earnings_nano_usd)],
        ["pending payout", formatUsd(first.earnings.payout_pending_nano_usd)],
        ["payout", payoutText],
        ["standard requests", String(usage.standard.requests)],
        [
          "premium requests",
          `${usage.premium.requests} (earned ${formatUsd(usage.premium.earnings_nano_usd)})`
        ],
        ["range", `${first.range.from} to ${first.range.to}`],
        ["data as of", first.data_fresh_at],
        ["applications", String(applications.length)]
      ]),
      "",
      "Dashboard only, not available from the CLI:",
      `  payouts and payout onboarding: ${dashboardUrl(ctx.env)}`,
      `  members, invitations, ownership: ${dashboardUrl(ctx.env)}/members`,
      `  sign-in email and payout destination: ${dashboardUrl(ctx.env)}/settings`
    ].join("\n")
  );
  return 0;
}

interface TrafficDay {
  date: string;
  visitors: number;
  standard_requests: number;
  premium_requests: number;
  premium_earnings_nano_usd: string;
  standard_used_nano_usd?: string;
  premium_used_nano_usd?: string;
}

async function runTraffic(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const range: DayRange = resolveTrafficRange(
    { days: args.value("days"), from: args.value("from"), to: args.value("to") },
    ctx.deps.now()
  );
  const { client } = await session(ctx, "stats.view");
  const appId = args.value("app");
  const query: ReadQuery = { from: range.from, to: range.to };
  let usage: unknown;
  let days: TrafficDay[];

  if (appId === undefined) {
    const info = await client.business(query);
    const visitors = new Map(info.traffic.daily_visitors.map((day) => [day.date, day.count]));
    const requests = new Map(info.traffic.daily_usage.map((day) => [day.date, day]));
    usage = info.traffic.usage;
    days = eachDay(range).map((date) => ({
      date,
      visitors: visitors.get(date) ?? 0,
      standard_requests: requests.get(date)?.standard_requests ?? 0,
      premium_requests: requests.get(date)?.premium_requests ?? 0,
      premium_earnings_nano_usd: requests.get(date)?.premium_earnings_nano_usd ?? "0"
    }));
  } else {
    // The detail read pages its analytics; follow the cursor to the end.
    const analytics = new Map<string, TrafficDay>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const detail: BusinessApplicationDetail = await client.application(
        appId,
        cursor === null ? query : { ...query, cursor }
      );
      for (const day of detail.analytics.days) {
        analytics.set(day.day, {
          date: day.day,
          visitors: day.daily_visitors,
          standard_requests: day.standard_requests,
          premium_requests: day.premium_requests,
          premium_earnings_nano_usd: day.business_earnings_nano_usd,
          standard_used_nano_usd: day.standard_used_nano_usd,
          premium_used_nano_usd: day.premium_used_nano_usd
        });
      }
      cursor = detail.analytics.next_cursor;
      if (cursor === null) break;
    }
    // The per-application usage totals live on the business read's summary.
    const { applications } = await allApplications(client, query);
    const summary = applications.find((candidate) => candidate.id === appId);
    if (summary === undefined) {
      throw new CliError(
        ENLITT_ERROR_CODE.not_found,
        `Application ${appId} is not in this business.`,
        {
          action: "Run `enlitt app list` to see this business's applications."
        }
      );
    }
    usage = summary.usage;
    days = eachDay(range).map(
      (date) =>
        analytics.get(date) ?? {
          date,
          visitors: 0,
          standard_requests: 0,
          premium_requests: 0,
          premium_earnings_nano_usd: "0",
          standard_used_nano_usd: "0",
          premium_used_nano_usd: "0"
        }
    );
  }

  const header = "date        visitors  standard  premium  earnings";
  const lines = days.map(
    (day) =>
      `${day.date}  ${String(day.visitors).padStart(8)}  ${String(day.standard_requests).padStart(8)}  ${String(day.premium_requests).padStart(7)}  ${formatUsd(day.premium_earnings_nano_usd)}`
  );
  ctx.out.result(
    { range: { from: range.from, to: range.to }, usage, days },
    [`${range.fromDay} to ${range.toDay} (UTC)`, header, ...lines].join("\n")
  );
  return 0;
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

function applicationText(detail: BusinessApplicationDetail): string {
  return formatRows([
    ["id", detail.id],
    ["name", detail.name],
    ["environment", detail.environment],
    ["status", detail.status],
    ["client id", detail.client_id],
    ["redirect URIs", detail.redirect_uris.join(", ") || "(none)"],
    ["origins", detail.allowed_origins.join(", ") || "(none)"],
    ["premium credit", detail.premium_enabled ? "on" : "off"],
    ["keys", `${activeKeyCount(detail.api_keys)} active of ${detail.api_keys.length}`]
  ]);
}

async function runAppList(ctx: CliContext): Promise<number> {
  const { client } = await session(ctx, "stats.view");
  const { applications } = await allApplications(client);
  const rows = applications.map((app) => ({
    id: app.id,
    name: app.name,
    environment: app.environment,
    status: app.status,
    client_id: app.client_id,
    active_key_count: activeKeyCount(app.api_keys)
  }));
  const text =
    rows.length === 0
      ? "No applications. Create one with `enlitt app create`."
      : rows
          .map(
            (row) =>
              `${row.id}  ${row.name}  ${row.environment}  ${row.status}  ${row.active_key_count} active keys`
          )
          .join("\n");
  ctx.out.result({ applications: rows }, text);
  return 0;
}

async function runAppShow(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const id = await applicationIdOrLinked(ctx, args.positionals[0]);
  const { client } = await session(ctx, "stats.view");
  const detail = await client.application(id);
  ctx.out.result(withoutAnalytics(detail), applicationText(detail));
  return 0;
}

async function runAppCreate(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const name = requireValue(args, "name");
  const environment = requireValue(args, "environment");
  if (environment !== "test" && environment !== "live")
    throw usageError("--environment must be test or live");
  if (environment === "live") requireConfirm(args, "Creating a live application");
  const iconUrl = args.value("icon-url");
  const description = args.value("description");
  const { client } = await session(ctx, "apps.manage");
  const detail = await client.createApplication({
    name,
    environment,
    redirect_uris: args.list("redirect-uri"),
    allowed_origins: args.list("origin"),
    ...(iconUrl === undefined ? {} : { icon_url: iconUrl }),
    ...(description === undefined ? {} : { description })
  });
  let linked = false;
  if (args.bool("link")) {
    const existing = await readProject(ctx);
    await writeProject(ctx, projectFor(detail, existing?.envFile ?? DEFAULT_ENV_FILE));
    linked = true;
  }
  ctx.out.result(
    { ...withoutAnalytics(detail), linked },
    `${applicationText(detail)}${linked ? `\nLinked this project in ${PROJECT_FILE_NAME}.` : ""}`
  );
  return 0;
}

function projectFor(detail: BusinessApplicationDetail, envFile: string): ProjectFile {
  return {
    applicationId: detail.id,
    environment: detail.environment === "live" ? "live" : "test",
    redirectUris: detail.redirect_uris,
    allowedOrigins: detail.allowed_origins,
    envFile
  };
}

/**
 * Resolves one list's update from `--<replace>`, `--add-<x>`, and `--remove-<x>`.
 * Returns undefined when none was given. Mixing replace with add or remove is a
 * `usage_error`.
 */
async function computeList(
  args: ParsedArgs,
  names: { replace: string; add: string; remove: string },
  current: () => Promise<readonly string[]>
): Promise<string[] | undefined> {
  const replacing = args.has(names.replace);
  const adding = args.has(names.add);
  const removing = args.has(names.remove);
  if (replacing && (adding || removing)) {
    throw usageError(
      `--${names.replace} replaces the list and cannot be mixed with --${names.add} or --${names.remove}`
    );
  }
  if (replacing) return [...args.list(names.replace)];
  if (!adding && !removing) return undefined;
  const removed = new Set(args.list(names.remove));
  const merged = [...(await current()), ...args.list(names.add)].filter(
    (value) => !removed.has(value)
  );
  return [...new Set(merged)];
}

async function runAppUpdate(args: ParsedArgs, ctx: CliContext): Promise<number> {
  if (args.has("icon-url") && args.bool("clear-icon-url"))
    throw usageError("--icon-url and --clear-icon-url cannot be mixed");
  if (args.has("description") && args.bool("clear-description")) {
    throw usageError("--description and --clear-description cannot be mixed");
  }
  const id = await applicationIdOrLinked(ctx, args.positionals[0]);
  const { client } = await session(ctx, "apps.manage");

  // The current detail is read once, and only when an add or remove form needs it.
  let currentDetail: BusinessApplicationDetail | undefined;
  const current = async (): Promise<BusinessApplicationDetail> =>
    (currentDetail ??= await client.application(id));
  const redirectUris = await computeList(
    args,
    { replace: "redirect-uri", add: "add-redirect-uri", remove: "remove-redirect-uri" },
    async () => (await current()).redirect_uris
  );
  const origins = await computeList(
    args,
    { replace: "origin", add: "add-origin", remove: "remove-origin" },
    async () => (await current()).allowed_origins
  );

  const name = args.value("name");
  const iconUrl = args.bool("clear-icon-url") ? null : args.value("icon-url");
  const description = args.bool("clear-description") ? null : args.value("description");
  const request = {
    ...(name === undefined ? {} : { name }),
    ...(redirectUris === undefined ? {} : { redirect_uris: redirectUris }),
    ...(origins === undefined ? {} : { allowed_origins: origins }),
    ...(iconUrl === undefined ? {} : { icon_url: iconUrl }),
    ...(description === undefined ? {} : { description })
  };
  if (Object.keys(request).length === 0)
    throw usageError("nothing to update: pass at least one field flag");

  const detail = await client.updateApplication(id, request);
  if (redirectUris !== undefined || origins !== undefined) {
    const project = await readProject(ctx);
    if (project !== null && project.applicationId === detail.id) {
      await writeProject(ctx, {
        ...project,
        redirectUris: detail.redirect_uris,
        allowedOrigins: detail.allowed_origins
      });
    }
  }
  ctx.out.result(withoutAnalytics(detail), applicationText(detail));
  return 0;
}

/**
 * `enlitt app premium [<id>] (--on | --off) [--confirm]` (owner decision
 * 2026-10-25). Exactly one of `--on`/`--off`, checked before any request.
 *
 * The current detail is read first, for two reasons: `--off` on a `live`
 * application needs `--confirm` (it refuses that application's premium calls
 * at once, in-flight ones included, and none of them is charged), and
 * `changed` reports whether the application already held the value. The
 * confirmation gate still runs before the `PUT`, so a refused `--off`
 * changes nothing. The server answers an unchanged value as a no-op.
 */
async function runAppPremium(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const on = args.bool("on");
  const off = args.bool("off");
  if (on === off) throw usageError("pass exactly one of --on and --off");
  const id = await applicationIdOrLinked(ctx, args.positionals[0]);
  const { client } = await session(ctx, "premium.manage");
  const before = await client.application(id);
  if (off && before.environment === "live") {
    requireConfirm(args, "Turning off premium credit on a live application");
  }
  const detail = await client.setApplicationPremium(id, { enabled: on });
  const changed = before.premium_enabled !== detail.premium_enabled;
  const application = {
    id: detail.id,
    name: detail.name,
    environment: detail.environment,
    premium_enabled: detail.premium_enabled
  };
  const state = detail.premium_enabled ? "on" : "off";
  const lines = [
    changed
      ? `Premium credit is now ${state} for ${detail.name} (${detail.id}).`
      : `Premium credit was already ${state} for ${detail.name} (${detail.id}).`
  ];
  if (detail.premium_enabled) {
    lines.push("Each user's premium limit starts at zero until the user raises it.");
  } else {
    lines.push("Premium calls are refused, and none of them is charged.");
  }
  ctx.out.result({ application, changed }, lines.join("\n"));
  return 0;
}

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

/** Where a minted secret goes. Chosen and validated before any request. */
type Destination =
  | {
      readonly kind: "file";
      readonly file: string;
      readonly variable: string;
      readonly replace: boolean;
    }
  | { readonly kind: "reveal" };

function planDestination(
  args: ParsedArgs,
  ctx: CliContext,
  defaultVariable: string,
  replaceByDefault: boolean
): Destination {
  const file = args.value("write-env");
  const reveal = args.bool("reveal");
  if (reveal && ctx.json) throw usageError("--reveal cannot be used with --json");
  if (reveal && file !== undefined)
    throw usageError("use either --write-env or --reveal, not both");
  if (file === undefined && !reveal) {
    throw new CliError(
      "secret_destination_required",
      "No destination was given for the new secret."
    );
  }
  if (file === undefined) {
    if (args.has("var") || args.bool("replace"))
      throw usageError("--var and --replace go with --write-env");
    if (!ctx.deps.isTTY.stdout) {
      throw new CliError(
        "reveal_requires_terminal",
        "--reveal prints a secret only to a terminal.",
        {
          action: "Rerun with `--write-env <file>`."
        }
      );
    }
    return { kind: "reveal" };
  }
  const variable = args.value("var") ?? defaultVariable;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
    throw usageError("--var must be a valid variable name");
  return { kind: "file", file, variable, replace: replaceByDefault || args.bool("replace") };
}

/** Refuses before minting when the destination file is already known to be unusable. */
async function preflightDestination(ctx: CliContext, destination: Destination): Promise<void> {
  if (destination.kind === "file") {
    await checkEnvTarget(ctx, {
      file: destination.file,
      name: destination.variable,
      replace: destination.replace
    });
  }
}

/** What a delivered secret adds to the command's result. */
interface Delivery {
  readonly extra: Record<string, unknown>;
  readonly where: string;
}

/**
 * Hands a freshly minted secret to its destination. A failure after minting
 * names the key so it can be revoked, and never carries the secret.
 */
async function deliverSecret(
  ctx: CliContext,
  minted: CreateBusinessKeyResponse,
  destination: Destination
): Promise<Delivery> {
  if (destination.kind === "reveal") {
    return { extra: {}, where: "The secret is printed once below." };
  }
  try {
    const written = await upsertEnvValue(ctx, {
      file: destination.file,
      name: destination.variable,
      value: minted.secret,
      replace: destination.replace,
      secret: true
    });
    return {
      extra: {
        secret_written_to: { file: written.file, variable: destination.variable },
        gitignored: written.gitignored
      },
      where: `The secret was written to ${written.file} as ${destination.variable}.`
    };
  } catch (error) {
    const code = error instanceof CliError ? error.code : "secret_not_saved";
    const reason = error instanceof CliError ? error.message : "The env file could not be written.";
    throw new CliError(
      code,
      `${reason} The key ${minted.metadata.id} was created but its secret was not saved.`,
      {
        action: `Revoke it with \`enlitt key revoke ${minted.metadata.id} --confirm\`, then create another.`
      }
    );
  }
}

/** The human-facing label of a key's scope; `--json` output keeps the wire value. */
function scopeLabel(scope: string): string {
  return scope === "model" || scope === "reporting"
    ? API_KEY_SCOPE_LABELS[scope].label
    : UNKNOWN_API_KEY_SCOPE_LABEL;
}

/**
 * Reads `--scope`. Accepts the display names `app` / `read-only` and the wire names
 * `model` / `reporting` as aliases; returns the wire value. Defaults to the App key.
 */
function parseScopeFlag(args: ParsedArgs): "model" | "reporting" {
  const raw = args.value("scope") ?? "app";
  if (raw === "app" || raw === "model") return "model";
  if (raw === "read-only" || raw === "reporting") return "reporting";
  throw usageError("--scope must be app, read-only, model, or reporting");
}

function keyText(key: ApiKeyMetadata): string {
  return `${key.id}  ${key.name}  ${scopeLabel(key.scope)}  ${key.environment ?? "-"}  ${key.status}  ${key.prefix}…`;
}

async function runKeyList(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const scope = parseScopeFlag(args);
  const appId = args.value("app");
  if (scope === "reporting" && appId !== undefined)
    throw usageError("--app goes with App keys, not --scope read-only");
  // Read-only keys are owner-only; App keys come from the stats reads.
  const { client } = await session(ctx, scope === "reporting" ? "keys.manage" : "stats.view");
  let keys: readonly ApiKeyMetadata[];
  if (scope === "reporting") {
    keys = await withStepUp(ctx, () => client.listKeys({ scope: "reporting" }));
  } else if (appId !== undefined) {
    keys = (await client.application(appId)).api_keys;
  } else {
    keys = (await allApplications(client)).applications.flatMap((app) => app.api_keys);
  }
  ctx.out.result({ keys }, keys.length === 0 ? "No keys." : keys.map(keyText).join("\n"));
  return 0;
}

async function runKeyCreate(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const scope = parseScopeFlag(args);
  const appId = args.value("app");
  if (scope === "reporting" && appId !== undefined)
    throw usageError("--app goes with App keys, not --scope read-only");
  if (scope === "model" && appId === undefined)
    throw usageError("pass --app <id>, or --scope read-only");
  const name = requireValue(args, "name");
  const destination = planDestination(
    args,
    ctx,
    scope === "reporting" ? REPORTING_KEY_VARIABLE : SECRET_KEY_VARIABLE,
    false
  );
  await preflightDestination(ctx, destination);

  const { client } = await session(ctx, "keys.manage");
  const minted = await withStepUp(ctx, () =>
    client.createKey({ scope, name, ...(appId === undefined ? {} : { application_id: appId }) })
  );
  const delivery = await deliverSecret(ctx, minted, destination);
  ctx.out.result(
    { key: minted.metadata, ...delivery.extra },
    `Created key ${keyText(minted.metadata)}\n${delivery.where}`
  );
  if (destination.kind === "reveal") ctx.out.revealSecret("secret", minted.secret);
  return 0;
}

/** Finds a key's metadata by ID among App keys, then Read-only keys. */
async function findKey(
  ctx: CliContext,
  client: DashboardClient,
  keyId: string
): Promise<ApiKeyMetadata> {
  const model = (await allApplications(client)).applications.flatMap((app) => app.api_keys);
  const found =
    model.find((key) => key.id === keyId) ??
    (await withStepUp(ctx, () => client.listKeys({ scope: "reporting" }))).find(
      (key) => key.id === keyId
    );
  if (found === undefined) {
    throw new CliError(ENLITT_ERROR_CODE.not_found, `No key ${keyId} in this business.`, {
      action: "Run `enlitt key list`."
    });
  }
  return found;
}

async function runKeyRotate(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const keyId = args.positionals[0]!;
  // Validate the destination first so a usage error never costs a request.
  // The default variable depends on the key's scope, so it is settled after the read.
  const hasDestination = args.has("write-env") || args.bool("reveal");
  if (!hasDestination) planDestination(args, ctx, SECRET_KEY_VARIABLE, true);
  const { client } = await session(ctx, "keys.manage");
  const key = await findKey(ctx, client, keyId);
  // A Read-only key has no environment and affects live reporting, so it is gated too.
  if (key.environment !== "test") requireConfirm(args, "Rotating a live key");
  const destination = planDestination(
    args,
    ctx,
    key.scope === "reporting" ? REPORTING_KEY_VARIABLE : SECRET_KEY_VARIABLE,
    true
  );
  await preflightDestination(ctx, destination);

  const minted = await withStepUp(ctx, () => client.rotateKey(keyId));
  const delivery = await deliverSecret(ctx, minted, destination);

  // The follow-up read says when the old key stops working. Losing it must not lose the secret.
  let previous: ApiKeyMetadata | null = null;
  try {
    const listed = await client.listKeys({
      scope: key.scope === "reporting" ? "reporting" : "model",
      ...(key.application_id === null ? {} : { application_id: key.application_id })
    });
    previous = listed.find((candidate) => candidate.id === keyId) ?? null;
  } catch {
    ctx.out.progress("Could not read the previous key's expiry; run `enlitt key list`.");
  }
  const expiry =
    previous?.expires_at != null
      ? `The previous key keeps working until ${previous.expires_at}; update the deployed app before then.`
      : "The previous key's expiry could not be read; run `enlitt key list` to check it.";
  ctx.out.result(
    { key: minted.metadata, ...delivery.extra, previous_key: previous },
    `Rotated key ${keyText(minted.metadata)}\n${delivery.where}\n${expiry}`
  );
  if (destination.kind === "reveal") ctx.out.revealSecret("secret", minted.secret);
  return 0;
}

async function runKeyRevoke(args: ParsedArgs, ctx: CliContext): Promise<number> {
  requireConfirm(args, "Revoking a key is immediate and cannot be undone, so it");
  const keyId = args.positionals[0]!;
  const { client } = await session(ctx, "keys.manage");
  const remaining = await withStepUp(ctx, () => client.revokeKey(keyId));
  const revoked = remaining.find((key) => key.id === keyId);
  if (revoked === undefined) {
    throw new CliError(
      "invalid_response",
      `Key ${keyId} was not in the list the API returned after revoking.`,
      {
        action: "Run `enlitt key list` to check its state."
      }
    );
  }
  ctx.out.result({ revoked }, `Revoked key ${keyText(revoked)}`);
  return 0;
}

// ---------------------------------------------------------------------------
// setup, doctor
// ---------------------------------------------------------------------------

async function runSetup(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const project = await readProject(ctx);
  // The language picks the default env file (`.env.local` for Node, `.env`
  // otherwise) and the docs page; an explicit flag or a linked project wins.
  const language = await detectLanguage(await findProjectRoot(ctx));
  const envFile = args.value("env-file") ?? project?.envFile ?? defaultEnvFileFor(language);
  const replaceSecret = args.bool("replace-secret");

  // Refuse an unusable env file before creating anything.
  const present = await readEnvPresence(ctx, envFile, [SECRET_KEY_VARIABLE]);
  const needSecret = present[SECRET_KEY_VARIABLE] !== true || replaceSecret;
  await checkEnvTarget(ctx, { file: envFile, name: CLIENT_ID_VARIABLE, replace: true });
  if (needSecret)
    await checkEnvTarget(ctx, { file: envFile, name: SECRET_KEY_VARIABLE, replace: true });

  // 1. Resolve the application. Creation flags are validated before any request.
  const existingId = args.value("app") ?? project?.applicationId;
  const createEnvironment = args.value("environment") ?? "test";
  if (existingId === undefined) {
    if (createEnvironment !== "test" && createEnvironment !== "live")
      throw usageError("--environment must be test or live");
    requireValue(args, "name");
    if (createEnvironment === "live") requireConfirm(args, "Creating a live application");
  }

  // Creating needs `apps.manage`; reusing an application only needs to read it.
  const { client, business } = await session(
    ctx,
    existingId === undefined ? "apps.manage" : "stats.view"
  );
  const canMintKey = business?.permissions.includes("keys.manage") ?? false;

  let detail: BusinessApplicationDetail;
  if (existingId !== undefined) {
    if (
      args.has("name") ||
      args.has("environment") ||
      args.has("redirect-uri") ||
      args.has("origin")
    ) {
      ctx.out.progress("Using the existing application; creation flags are ignored.");
    }
    detail = await client.application(existingId);
  } else {
    detail = await client.createApplication({
      name: requireValue(args, "name"),
      environment: createEnvironment as "test" | "live",
      redirect_uris: args.list("redirect-uri"),
      allowed_origins: args.list("origin")
    });
  }

  // 2. The project file, written before the env file so a rerun finds the link.
  await writeProject(ctx, projectFor(detail, envFile));

  // 3 and 4. Public values.
  const wrote: string[] = [];
  let gitignored = false;
  const upsertPublic = async (name: string, value: string): Promise<void> => {
    const result = await upsertEnvValue(ctx, {
      file: envFile,
      name,
      value,
      replace: true,
      secret: false
    });
    wrote.push(name);
    gitignored ||= result.gitignored;
  };
  await upsertPublic(CLIENT_ID_VARIABLE, detail.client_id);
  if (ctx.env !== "production" || ctx.deps.env.ENLITT_CLI_API_ORIGIN !== undefined) {
    await upsertPublic("ENLITT_BASE_URL", ctx.apiOrigin);
  }

  // 5. The secret, only when none exists or the developer asked for a new one,
  // and only for a login that holds `keys.manage`; otherwise it is reported in `missing`.
  const missing: { variable: string; action: string }[] = [];
  if (needSecret && !canMintKey) {
    missing.push({
      variable: SECRET_KEY_VARIABLE,
      action: `Only the business owner can create keys. Ask the owner to create an app key for ${detail.name} (${detail.id}) and put it in ${SECRET_KEY_VARIABLE} in ${envFile}.`
    });
  } else if (needSecret) {
    const date = ctx.deps.now().toISOString().slice(0, 10);
    const minted = await withStepUp(ctx, () =>
      client.createKey({ scope: "model", name: `cli setup ${date}`, application_id: detail.id })
    );
    const delivery = await deliverSecret(ctx, minted, {
      kind: "file",
      file: envFile,
      variable: SECRET_KEY_VARIABLE,
      replace: true
    });
    wrote.push(SECRET_KEY_VARIABLE);
    const written = delivery.extra.gitignored;
    gitignored ||= written === true;
  }

  const docsPage = { node: "authentication", python: "python", dotnet: "dotnet" }[language];
  const next = `Read ${siteOrigin(ctx.env)}/docs/${docsPage}.md to add sign-in to your app.`;
  ctx.out.result(
    {
      application: {
        id: detail.id,
        name: detail.name,
        environment: detail.environment,
        client_id: detail.client_id
      },
      env_file: envFile,
      wrote,
      gitignored,
      project_file: PROJECT_FILE_NAME,
      language,
      missing,
      next
    },
    [
      `Set up ${detail.name} (${detail.id}, ${detail.environment}).`,
      `Wrote ${wrote.join(", ")} to ${envFile}.`,
      ...missing.map((entry) => entry.action),
      next
    ].join("\n")
  );
  return 0;
}

async function runDoctorCommand(args: ParsedArgs, ctx: CliContext): Promise<number> {
  const findings = await runDoctor(ctx, {
    app: args.value("app"),
    envFile: args.value("env-file"),
    callbackUrls: args.list("callback-url")
  });
  const ok = !findings.some((finding) => finding.severity === "error");
  const text =
    findings.length === 0
      ? "No problems found."
      : findings
          .map((f) => `${f.severity}: ${f.code}: ${f.message}\n  next: ${f.action}`)
          .join("\n");
  ctx.out.result({ ok, findings }, text);
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// `--help` text for every flag (one line each, with the default where there is one)
// ---------------------------------------------------------------------------

const FLAG_NO_BROWSER: FlagDoc = {
  description: "print the URL and code without opening a browser",
  default: "opens the browser unless CI is set or BROWSER=none"
};
const FLAG_NO_WAIT: FlagDoc = {
  description: "start the authorization, save it, and exit; resume later with --wait"
};
const FLAG_WAIT: FlagDoc = {
  description: "resume the saved authorization and poll until it is decided"
};
const FLAG_TIMEOUT: FlagDoc = {
  value: "<seconds>",
  description: "stop one --wait run after this long, keeping the saved authorization",
  default: "until the authorization expires"
};
const AUTH_FLAG_DOCS: Readonly<Record<string, FlagDoc>> = {
  "no-browser": FLAG_NO_BROWSER,
  "no-wait": FLAG_NO_WAIT,
  wait: FLAG_WAIT,
  timeout: FLAG_TIMEOUT
};
const FLAG_APP: FlagDoc = { value: "<id>", description: "the application ID" };
const FLAG_CONFIRM: FlagDoc = {
  description:
    "the developer has explicitly approved this action; never pass it without their go-ahead"
};
const FLAG_FROM: FlagDoc = {
  value: "<date>",
  description: "first day of the range, YYYY-MM-DD (UTC, inclusive); goes with --to",
  default: "the server's default window"
};
const FLAG_TO: FlagDoc = {
  value: "<date>",
  description: "last day of the range, YYYY-MM-DD (UTC, inclusive)",
  default: "today"
};
const FLAG_REDIRECT_URI: FlagDoc = {
  value: "<url>",
  description: "a registered sign-in callback URL"
};
const FLAG_ORIGIN: FlagDoc = { value: "<origin>", description: "an allowed browser origin" };
const FLAG_WRITE_ENV: FlagDoc = {
  value: "<file>",
  description: "write the new secret to this untracked env file; it is never printed"
};
const FLAG_REPLACE: FlagDoc = {
  description: "overwrite the variable if the env file already holds it"
};
const FLAG_REVEAL: FlagDoc = {
  description:
    "print the secret on stdout instead (human output on a terminal only; not with --json)"
};
const FLAG_ENV_FILE: FlagDoc = {
  value: "<file>",
  description: "the env file to use",
  default: DEFAULT_ENV_FILE
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** The error type is re-exported for callers that want to recognize server refusals. */
export { EnlittDashboardError };

const COMMAND_DEFINITIONS: readonly Command[] = [
  {
    name: ["login"],
    summary: "Sign in to a business through the browser",
    usage: "login [--label <text>] [--no-browser] [--no-wait | --wait] [--timeout <seconds>]",
    flags: { ...AUTH_FLAGS, label: "value" },
    flagDocs: {
      ...AUTH_FLAG_DOCS,
      label: {
        value: "<text>",
        description: "the name this credential shows in the dashboard",
        default: "<hostname> (<platform>)"
      }
    },
    positionals: [],
    requiredPositionals: 0,
    run: (args, ctx) => authFlow("login", args, ctx)
  },
  {
    name: ["reauth"],
    summary: "Approve sensitive actions again in the browser",
    usage: "reauth [--no-browser] [--no-wait | --wait] [--timeout <seconds>]",
    flags: AUTH_FLAGS,
    flagDocs: AUTH_FLAG_DOCS,
    positionals: [],
    requiredPositionals: 0,
    run: (args, ctx) => authFlow("step_up", args, ctx)
  },
  {
    name: ["logout"],
    summary: "Revoke and delete this machine's credential",
    usage: "logout",
    flags: {},
    positionals: [],
    requiredPositionals: 0,
    run: async (_args, ctx) => {
      const credential = await loadCredential(ctx);
      let revoked = false;
      if (credential !== null) {
        try {
          await createDashboardClient(ctx, credential).revokeCredential();
          revoked = true;
        } catch {
          // The file is deleted either way; the credential also expires on its own.
        }
      }
      await deleteCredential(ctx);
      const loggedOut = credential !== null;
      ctx.out.result(
        { logged_out: loggedOut, revoked },
        loggedOut
          ? `Logged out${revoked ? "" : " (the server could not be told to revoke the credential)"}.`
          : "Not logged in."
      );
      return 0;
    }
  },
  {
    name: ["whoami"],
    summary: "Show the signed-in login and business",
    usage: "whoami",
    flags: {},
    positionals: [],
    requiredPositionals: 0,
    run: async (_args, ctx) => {
      const { credential, client } = await session(ctx, null);
      const document = await identity(ctx, credential, client);
      ctx.out.result(document, identityText(document));
      return 0;
    }
  },
  {
    name: ["status"],
    summary: "Show the login and the project link without failing when logged out",
    usage: "status",
    flags: {},
    positionals: [],
    requiredPositionals: 0,
    run: (_args, ctx) => runStatus(ctx)
  },
  {
    name: ["business", "info"],
    summary: "Show earnings, payout eligibility, and traffic totals",
    usage: "business info [--from <date>] [--to <date>]",
    flags: { from: "value", to: "value" },
    flagDocs: { from: FLAG_FROM, to: FLAG_TO },
    positionals: [],
    requiredPositionals: 0,
    run: runBusinessInfo
  },
  {
    name: ["traffic"],
    summary: "Show daily traffic for the business or one application",
    usage: "traffic [--app <id>] [--days <n> | --from <date> --to <date>]",
    flags: { app: "value", days: "value", from: "value", to: "value" },
    flagDocs: {
      app: { value: "<id>", description: "show one application instead of the whole business" },
      days: { value: "<n>", description: "the last n days, 1 to 3660", default: "30" },
      from: {
        value: "<date>",
        description: "first day, YYYY-MM-DD (UTC, inclusive); needs --to",
        default: "the last --days days"
      },
      to: { value: "<date>", description: "last day, YYYY-MM-DD (UTC, inclusive); needs --from" }
    },
    positionals: [],
    requiredPositionals: 0,
    run: runTraffic
  },
  {
    name: ["app", "list"],
    summary: "List the business's applications",
    usage: "app list",
    flags: {},
    positionals: [],
    requiredPositionals: 0,
    run: (_args, ctx) => runAppList(ctx)
  },
  {
    name: ["app", "show"],
    summary: "Show one application",
    usage: "app show [<id>]",
    flags: {},
    positionals: ["id"],
    requiredPositionals: 0,
    run: runAppShow
  },
  {
    name: ["app", "create"],
    summary: "Create an application",
    usage:
      "app create --name <n> --environment test|live [--redirect-uri <url>]… [--origin <origin>]… [--icon-url <url>] [--description <text>] [--link] [--confirm]",
    flags: {
      name: "value",
      environment: "value",
      "redirect-uri": "list",
      origin: "list",
      "icon-url": "value",
      description: "value",
      link: "bool",
      confirm: "bool"
    },
    flagDocs: {
      name: { value: "<n>", description: "the application's display name (required)" },
      environment: {
        value: "test|live",
        description: "test, or live for real users (live needs --confirm; required)"
      },
      "redirect-uri": FLAG_REDIRECT_URI,
      origin: FLAG_ORIGIN,
      "icon-url": { value: "<url>", description: "the application's icon URL" },
      description: {
        value: "<text>",
        description: "a short description shown on the sign-in page"
      },
      link: { description: "write enlitt.json so this project uses the new application" },
      confirm: FLAG_CONFIRM
    },
    positionals: [],
    requiredPositionals: 0,
    run: runAppCreate
  },
  {
    name: ["app", "update"],
    summary: "Change an application's name, redirect URIs, origins, or presentation",
    usage:
      "app update [<id>] [--name <n>] [--redirect-uri <url>… | --add-redirect-uri <url>… | --remove-redirect-uri <url>…] [--origin … | --add-origin … | --remove-origin …] [--icon-url <url> | --clear-icon-url] [--description <t> | --clear-description]",
    flags: {
      name: "value",
      "redirect-uri": "list",
      "add-redirect-uri": "list",
      "remove-redirect-uri": "list",
      origin: "list",
      "add-origin": "list",
      "remove-origin": "list",
      "icon-url": "value",
      "clear-icon-url": "bool",
      description: "value",
      "clear-description": "bool"
    },
    flagDocs: {
      name: { value: "<n>", description: "the application's new display name" },
      "redirect-uri": {
        ...FLAG_REDIRECT_URI,
        description: "replace the whole callback URL list with this"
      },
      "add-redirect-uri": {
        ...FLAG_REDIRECT_URI,
        description: "add a callback URL to the registered list"
      },
      "remove-redirect-uri": {
        ...FLAG_REDIRECT_URI,
        description: "remove a callback URL from the registered list"
      },
      origin: { ...FLAG_ORIGIN, description: "replace the whole allowed origin list with this" },
      "add-origin": { ...FLAG_ORIGIN, description: "add an allowed origin to the registered list" },
      "remove-origin": {
        ...FLAG_ORIGIN,
        description: "remove an allowed origin from the registered list"
      },
      "icon-url": { value: "<url>", description: "set the application's icon URL" },
      "clear-icon-url": { description: "remove the application's icon" },
      description: { value: "<text>", description: "set the application's description" },
      "clear-description": { description: "remove the application's description" }
    },
    positionals: ["id"],
    requiredPositionals: 0,
    run: runAppUpdate
  },
  {
    name: ["app", "premium"],
    summary: "Turn an application's premium credit on or off",
    usage: "app premium [<id>] (--on | --off) [--confirm]",
    flags: { on: "bool", off: "bool", confirm: "bool" },
    flagDocs: {
      on: {
        description:
          "charge premium credit; each user's premium limit starts at zero until the user raises it"
      },
      off: {
        description:
          "refuse premium calls at once, in-flight ones included, and charge none of them (live needs --confirm)"
      },
      confirm: FLAG_CONFIRM
    },
    positionals: ["id"],
    requiredPositionals: 0,
    run: runAppPremium
  },
  {
    name: ["key", "list"],
    summary: "List API keys (metadata only)",
    usage: "key list [--app <id>] [--scope app|read-only]",
    flags: { app: "value", scope: "value" },
    flagDocs: {
      app: {
        ...FLAG_APP,
        description: "list this application's keys",
        default: "every application's keys"
      },
      scope: {
        value: "app|read-only",
        description:
          "which keys to list (model and reporting are accepted aliases); read-only needs the keys.manage permission and a recent approval",
        default: "app"
      }
    },
    positionals: [],
    requiredPositionals: 0,
    run: runKeyList
  },
  {
    name: ["key", "create"],
    summary: "Create an API key and write its secret to an env file",
    usage:
      "key create (--app <id> | --scope read-only) --name <n> (--write-env <file> [--replace] [--var <NAME>] | --reveal)",
    flags: {
      app: "value",
      scope: "value",
      name: "value",
      "write-env": "value",
      replace: "bool",
      var: "value",
      reveal: "bool"
    },
    flagDocs: {
      app: { ...FLAG_APP, description: "create an App key for this application" },
      scope: {
        value: "app|read-only",
        description:
          "create a business-wide Read-only key instead of an App key (model and reporting are accepted aliases)",
        default: "app"
      },
      name: { value: "<n>", description: "the key's display name (required)" },
      "write-env": FLAG_WRITE_ENV,
      replace: FLAG_REPLACE,
      var: {
        value: "<NAME>",
        description: "the variable name to write",
        default: "ENLITT_SECRET_KEY (App key) or ENLITT_REPORTING_KEY (Read-only key)"
      },
      reveal: FLAG_REVEAL
    },
    positionals: [],
    requiredPositionals: 0,
    run: runKeyCreate
  },
  {
    name: ["key", "rotate"],
    summary: "Rotate an API key and write the new secret",
    usage:
      "key rotate <key_id> (--write-env <file> [--replace] [--var <NAME>] | --reveal) [--confirm]",
    flags: { "write-env": "value", replace: "bool", var: "value", reveal: "bool", confirm: "bool" },
    flagDocs: {
      "write-env": FLAG_WRITE_ENV,
      replace: { ...FLAG_REPLACE, default: "on, since replacing the old value is the point" },
      var: {
        value: "<NAME>",
        description: "the variable name to write",
        default: "ENLITT_SECRET_KEY (App key) or ENLITT_REPORTING_KEY (Read-only key)"
      },
      reveal: FLAG_REVEAL,
      confirm: {
        ...FLAG_CONFIRM,
        description:
          "required for a live App key or a Read-only key; the old key keeps working for a grace period"
      }
    },
    positionals: ["key_id"],
    requiredPositionals: 1,
    run: runKeyRotate
  },
  {
    name: ["key", "revoke"],
    summary: "Revoke an API key immediately",
    usage: "key revoke <key_id> --confirm",
    flags: { confirm: "bool" },
    flagDocs: {
      confirm: {
        ...FLAG_CONFIRM,
        description: "required: revoking is immediate and cannot be undone"
      }
    },
    positionals: ["key_id"],
    requiredPositionals: 1,
    run: runKeyRevoke
  },
  {
    name: ["setup"],
    summary: "Link this project to an application and write its env file",
    usage:
      "setup [--app <id>] [--name <n>] [--environment test|live] [--redirect-uri <url>]… [--origin <origin>]… [--env-file <file>] [--replace-secret] [--confirm]",
    flags: {
      app: "value",
      name: "value",
      environment: "value",
      "redirect-uri": "list",
      origin: "list",
      "env-file": "value",
      "replace-secret": "bool",
      confirm: "bool"
    },
    flagDocs: {
      app: {
        ...FLAG_APP,
        description: "use this existing application",
        default: "the one in enlitt.json, else create one"
      },
      name: { value: "<n>", description: "the new application's name (required when creating)" },
      environment: {
        value: "test|live",
        description: "the new application's environment",
        default: "test"
      },
      "redirect-uri": FLAG_REDIRECT_URI,
      origin: FLAG_ORIGIN,
      "env-file": FLAG_ENV_FILE,
      "replace-secret": {
        description: "mint a new secret key even when the env file already has one"
      },
      confirm: {
        ...FLAG_CONFIRM,
        description: "required only when setup creates a live application"
      }
    },
    positionals: [],
    requiredPositionals: 0,
    run: runSetup
  },
  {
    name: ["doctor"],
    summary: "Check the project, env file, and application agree",
    usage: "doctor [--app <id>] [--env-file <file>] [--callback-url <url>]…",
    flags: { app: "value", "env-file": "value", "callback-url": "list" },
    flagDocs: {
      app: {
        ...FLAG_APP,
        description: "check this application",
        default: "the one in enlitt.json"
      },
      "env-file": FLAG_ENV_FILE,
      "callback-url": {
        value: "<url>",
        description: "also check that this callback URL is registered"
      }
    },
    positionals: [],
    requiredPositionals: 0,
    run: runDoctorCommand
  }
];

/** Every command, with server role refusals explained like the local check. */
export const COMMANDS: readonly Command[] = COMMAND_DEFINITIONS.map(explainingRoleRefusals);
