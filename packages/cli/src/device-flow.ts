/**
 * Browser-approved device authorization for `login` and `step_up`
 * (`specs/PROTOCOLS.md` "CLI authorization").
 *
 * A coding agent's shell call times out long before a developer finishes
 * approving, so the flow can be split: `start_only` saves the pending
 * authorization and returns, and `resume` polls from that file later. The
 * device code is a secret that lives only in memory and in the pending file
 * (mode `0600`); it is never printed.
 */
import { readFile, rm } from "node:fs/promises";

import { ENLITT_ERROR_CODE } from "@enlitt/protocol";
import type { CliTokenGrant } from "@enlitt/protocol";

import { createDashboardClient, EnlittDashboardError } from "./client.js";
import type { DashboardClient } from "./client.js";
import {
  assertPrivateFile,
  ensureConfigDirectory,
  pendingPath,
  requireCredential,
  writePrivateFile
} from "./credentials.js";
import type { StoredCredential } from "./credentials.js";
import type { CliContext } from "./main.js";
import { CliError } from "./output.js";

export type DeviceFlowKind = "login" | "step_up";

/** `now` starts and polls; `start_only` starts and saves; `resume` polls a saved one. */
export type DeviceFlowWait = "now" | "start_only" | "resume";

export interface DeviceFlowOptions {
  readonly label: string;
  readonly wait: DeviceFlowWait;
  /** Bounds one polling run; the authorization's own expiry is the default bound. */
  readonly timeoutMs?: number;
  readonly openBrowser: boolean;
}

/** What `--no-wait` reports: enough for a developer to approve, no secret. */
export interface PendingAuthorization {
  readonly status: "pending";
  readonly verification_uri_complete: string;
  readonly user_code: string;
  readonly expires_at: string;
}

interface PendingFile {
  readonly kind: DeviceFlowKind;
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri_complete: string;
  readonly expires_at: string;
  readonly interval: number;
  readonly api_origin: string;
}

/** Added to the poll interval after each `slow_down`, per RFC 8628. */
const SLOW_DOWN_STEP_MS = 5_000;

const COMMAND_FOR_KIND: Record<DeviceFlowKind, string> = { login: "login", step_up: "reauth" };

function noPending(kind: DeviceFlowKind): CliError {
  const command = COMMAND_FOR_KIND[kind];
  return new CliError(
    "no_pending_authorization",
    "There is no pending authorization to resume, or it has expired.",
    { action: `Run \`enlitt ${command} --no-wait\` first.` }
  );
}

async function removePending(ctx: CliContext): Promise<void> {
  await rm(pendingPath(ctx), { force: true });
}

function isPendingFile(value: unknown): value is PendingFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "login" || record.kind === "step_up") &&
    typeof record.device_code === "string" &&
    typeof record.user_code === "string" &&
    typeof record.verification_uri_complete === "string" &&
    typeof record.expires_at === "string" &&
    typeof record.interval === "number" &&
    typeof record.api_origin === "string"
  );
}

/** Reads the pending file for `kind`, or throws `no_pending_authorization`. */
async function readPending(ctx: CliContext, kind: DeviceFlowKind): Promise<PendingFile> {
  const path = pendingPath(ctx);
  let parsed: unknown;
  try {
    await assertPrivateFile(ctx, path);
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw noPending(kind);
  }
  if (!isPendingFile(parsed) || parsed.kind !== kind || parsed.api_origin !== ctx.apiOrigin) {
    throw noPending(kind);
  }
  if (Date.parse(parsed.expires_at) <= ctx.deps.now().getTime()) {
    await removePending(ctx);
    throw noPending(kind);
  }
  ctx.secrets.add(parsed.device_code);
  return parsed;
}

function describe(kind: DeviceFlowKind): string {
  return kind === "login" ? "sign in" : "re-approve";
}

/** Prints the URL and code to compare, and opens the browser unless told not to. */
async function announce(
  ctx: CliContext,
  kind: DeviceFlowKind,
  pending: { verification_uri_complete: string; user_code: string },
  openBrowser: boolean
): Promise<void> {
  ctx.out.progress(`To ${describe(kind)}, open: ${pending.verification_uri_complete}`);
  ctx.out.progress(`Confirm the page shows the code: ${pending.user_code}`);
  if (!openBrowser) return;
  try {
    await ctx.deps.openBrowser(pending.verification_uri_complete);
  } catch {
    // Opening a browser is a convenience; the URL above is the real instruction.
  }
}

/**
 * Polls `POST /v1/cli/token` until the developer decides, the authorization
 * expires, or `timeoutMs` passes. Every terminal outcome deletes the pending
 * file; a timeout or a network failure keeps it so `--wait` can resume.
 */
async function pollUntilDecided(
  ctx: CliContext,
  client: DashboardClient,
  kind: DeviceFlowKind,
  authorization: { deviceCode: string; intervalSeconds: number; expiresAtMs: number },
  timeoutMs: number | undefined
): Promise<CliTokenGrant> {
  const startedAt = ctx.deps.now().getTime();
  // `sleep` may be instant in tests, so time also advances by what was slept.
  let slept = 0;
  const clock = (): number => Math.max(ctx.deps.now().getTime(), startedAt + slept);
  const deadline = timeoutMs === undefined ? Infinity : startedAt + timeoutMs;
  let intervalMs = authorization.intervalSeconds * 1_000;
  const command = COMMAND_FOR_KIND[kind];

  for (;;) {
    if (clock() >= authorization.expiresAtMs) {
      await removePending(ctx);
      throw new CliError(ENLITT_ERROR_CODE.expired_token, "The authorization expired before it was approved.", {
        action: `Start again with \`enlitt ${command}\`.`
      });
    }
    try {
      const grant = await client.pollToken(authorization.deviceCode);
      await removePending(ctx);
      return grant;
    } catch (error) {
      if (!(error instanceof EnlittDashboardError)) throw error;
      switch (error.code) {
        case ENLITT_ERROR_CODE.authorization_pending:
          break;
        case ENLITT_ERROR_CODE.slow_down:
          intervalMs += SLOW_DOWN_STEP_MS;
          break;
        case ENLITT_ERROR_CODE.access_denied:
          await removePending(ctx);
          throw new CliError(ENLITT_ERROR_CODE.access_denied, "The developer denied the request.", {
            action: `Ask the developer to approve it, or start again with \`enlitt ${command}\`.`
          });
        case ENLITT_ERROR_CODE.expired_token:
          await removePending(ctx);
          throw new CliError(ENLITT_ERROR_CODE.expired_token, "The authorization expired before it was approved.", {
            action: `Start again with \`enlitt ${command}\`.`
          });
        default:
          throw error;
      }
    }
    if (clock() + intervalMs > deadline) {
      throw new CliError(ENLITT_ERROR_CODE.authorization_pending, "Still waiting for the developer to approve.", {
        action: `Run \`enlitt ${command} --wait\` to keep waiting.`
      });
    }
    await ctx.deps.sleep(intervalMs);
    slept += intervalMs;
  }
}

/**
 * Runs one device authorization. Returns the grant when a wait finishes
 * approved, or the pending summary when `start_only`.
 */
export async function runDeviceFlow(
  kind: DeviceFlowKind,
  options: DeviceFlowOptions,
  ctx: CliContext
): Promise<CliTokenGrant | PendingAuthorization> {
  // A step-up needs the credential it renews, in every mode.
  const credential: StoredCredential | null = kind === "step_up" ? await requireCredential(ctx) : null;
  const client = createDashboardClient(ctx, credential);

  if (options.wait === "resume") {
    const pending = await readPending(ctx, kind);
    ctx.out.progress("Waiting for approval…");
    return pollUntilDecided(
      ctx,
      client,
      kind,
      {
        deviceCode: pending.device_code,
        intervalSeconds: pending.interval,
        expiresAtMs: Date.parse(pending.expires_at)
      },
      options.timeoutMs
    );
  }

  const started = await client.startAuthorization({ kind, device_label: options.label });
  const expiresAtMs = ctx.deps.now().getTime() + started.expires_in * 1_000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  await announce(ctx, kind, started, options.openBrowser);

  // Both start modes save the pending file, so a poll that times out can be resumed.
  const pending: PendingFile = {
    kind,
    device_code: started.device_code,
    user_code: started.user_code,
    verification_uri_complete: started.verification_uri_complete,
    expires_at: expiresAt,
    interval: started.interval,
    api_origin: ctx.apiOrigin
  };
  await ensureConfigDirectory(ctx);
  await writePrivateFile(pendingPath(ctx), `${JSON.stringify(pending, null, 2)}\n`);

  if (options.wait === "start_only") {
    return {
      status: "pending",
      verification_uri_complete: started.verification_uri_complete,
      user_code: started.user_code,
      expires_at: expiresAt
    };
  }

  ctx.out.progress("Waiting for approval…");
  return pollUntilDecided(
    ctx,
    client,
    kind,
    { deviceCode: started.device_code, intervalSeconds: started.interval, expiresAtMs },
    options.timeoutMs
  );
}
