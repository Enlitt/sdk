/**
 * `enlitt doctor`: checks that the project, its env file, and the application
 * registered with Enlitt agree. Checks run in a fixed order, and one that
 * depends on an earlier failure is skipped rather than reported twice.
 *
 * The local secret key is compared with the application's key prefixes in this
 * process only; just the boolean result leaves it.
 */
import { ENLITT_ERROR_CODE } from "@enlitt/protocol";
import type { BusinessApplicationDetail } from "@enlitt/protocol";

import { createDashboardClient, EnlittDashboardError } from "./client.js";
import { loadCredential } from "./credentials.js";
import { inspectEnvFile, readEnvValueForCheck } from "./env-file.js";
import type { CliContext } from "./main.js";
import { printedCommand } from "./output.js";
import { DEFAULT_ENV_FILE, readProject } from "./project.js";

export interface Finding {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly action: string;
}

export interface DoctorOptions {
  readonly app: string | undefined;
  readonly envFile: string | undefined;
  readonly callbackUrls: readonly string[];
}

/** The variables the SDK reads, in `docs/authentication`. */
export const CLIENT_ID_VARIABLE = "ENLITT_CLIENT_ID";
export const SECRET_KEY_VARIABLE = "ENLITT_SECRET_KEY";

/** Codes meaning the credential cannot act as a business member right now. */
const REFUSAL_CODES = new Set([
  "not_logged_in",
  ENLITT_ERROR_CODE.dashboard_login_required,
  ENLITT_ERROR_CODE.business_selection_required,
  ENLITT_ERROR_CODE.insufficient_permissions
]);

function missing(values: readonly string[], registered: readonly string[]): string[] {
  return values.filter((value) => !registered.includes(value));
}

/** The origin of a URL, or undefined when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** First occurrences only, in order. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.join(", ");
}

export async function runDoctor(ctx: CliContext, options: DoctorOptions): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (finding: Finding): void => {
    findings.push(finding);
  };

  // 1. Login.
  const credential = await loadCredential(ctx);
  let loggedIn = false;
  const client = createDashboardClient(ctx, credential);
  if (credential !== null) {
    try {
      await client.access();
      loggedIn = true;
    } catch (error) {
      if (!(error instanceof EnlittDashboardError) || !REFUSAL_CODES.has(error.code)) throw error;
    }
  }
  if (!loggedIn) {
    add({
      code: "not_logged_in",
      severity: "error",
      message: "The CLI is not logged in to Enlitt, so the application cannot be checked.",
      action: "Run `enlitt login`."
    });
  }

  // 2. Project link.
  const project = await readProject(ctx);
  const applicationId = options.app ?? project?.applicationId;
  if (applicationId === undefined) {
    add({
      code: "project_not_linked",
      severity: "warning",
      message: "This project is not linked to an application (no enlitt.json and no --app).",
      action: "Run `enlitt setup` or pass `--app <id>`."
    });
  }

  // 3. The application.
  let application: BusinessApplicationDetail | null = null;
  if (loggedIn && applicationId !== undefined) {
    try {
      application = await client.application(applicationId);
    } catch (error) {
      if (!(error instanceof EnlittDashboardError) || error.status !== 404) throw error;
      add({
        code: "application_not_found",
        severity: "error",
        message: `Application ${applicationId} is not in this business.`,
        action:
          "Run `enlitt app list` to see this business's applications, then `enlitt setup --app <id>`."
      });
    }
  }
  if (application !== null && application.status !== "active") {
    add({
      code: "application_not_active",
      severity: "error",
      message: `Application ${application.id} is ${application.status}, not active.`,
      action: "Ask the business owner to reactivate it, or run `enlitt app create` for a new one."
    });
  }

  // 4. The env file.
  const envFile = options.envFile ?? project?.envFile ?? DEFAULT_ENV_FILE;
  const inspection = await inspectEnvFile(ctx, envFile);
  if (!inspection.exists) {
    add({
      code: "env_file_missing",
      severity: "error",
      message: `${envFile} does not exist.`,
      action: `Run \`enlitt setup --env-file ${envFile}\`.`
    });
  } else {
    if (inspection.tracked) {
      add({
        code: "env_file_tracked",
        severity: "error",
        message: `${envFile} is committed to git, so its secrets are exposed.`,
        action:
          "Run `git rm --cached` on it, rotate the key, and keep secrets in an untracked file such as `.env.local`."
      });
    } else if (inspection.ignored === false) {
      add({
        code: "env_file_not_ignored",
        severity: "warning",
        message: `${envFile} is not ignored by git.`,
        action: `Add /${envFile} to .gitignore.`
      });
    }
    if (inspection.looseMode) {
      add({
        code: "env_file_permissions",
        severity: "warning",
        message: `${envFile} is readable by other users.`,
        action: `Run \`chmod 600 ${envFile}\`.`
      });
    }
  }

  // 5. The client ID. Skipped when the file is missing: that is already reported.
  if (inspection.exists) {
    const clientId = await readEnvValueForCheck(ctx, envFile, CLIENT_ID_VARIABLE);
    if (clientId === undefined) {
      add({
        code: "client_id_missing",
        severity: "error",
        message: `${envFile} does not define ${CLIENT_ID_VARIABLE}.`,
        action: `Run \`enlitt setup --env-file ${envFile}\`.`
      });
    } else if (application !== null && clientId !== application.client_id) {
      add({
        code: "client_id_mismatch",
        severity: "error",
        message: `${CLIENT_ID_VARIABLE} in ${envFile} is not the client ID of application ${application.id}.`,
        action: `Run \`enlitt setup --app ${application.id} --env-file ${envFile}\`.`
      });
    }

    // 6. The secret key.
    const secret = await readEnvValueForCheck(ctx, envFile, SECRET_KEY_VARIABLE);
    if (secret === undefined) {
      add({
        code: "secret_key_missing",
        severity: "error",
        message: `${envFile} does not define ${SECRET_KEY_VARIABLE}.`,
        action: `Run \`enlitt key create --app ${applicationId ?? "<id>"} --name <n> --write-env ${envFile}\`.`
      });
    } else if (application !== null) {
      ctx.secrets.add(secret);
      const active = application.api_keys.some(
        (key) => key.scope === "model" && key.status === "active" && secret.startsWith(key.prefix)
      );
      if (!active) {
        add({
          code: "secret_key_not_active",
          severity: "error",
          message: `${SECRET_KEY_VARIABLE} in ${envFile} does not match an active key of application ${application.id}.`,
          action: `Run \`enlitt key create --app ${application.id} --name <n> --write-env ${envFile} --replace\`.`
        });
      }
    }
  }

  // 7. Callback URLs and origins.
  if (application !== null) {
    // The command that fixes a mismatch is printed in full, with every unregistered value
    // filled in. `app update` needs the ID unless it resolves to the linked project.
    const updateCommand = (flags: string[]): string =>
      printedCommand(
        ctx.env,
        [
          "app update",
          ...(project?.applicationId === application.id ? [] : [application.id]),
          ...flags
        ].join(" ")
      );

    const unregisteredCallbacks = unique(
      missing(
        [...options.callbackUrls, ...(project?.redirectUris ?? [])],
        application.redirect_uris
      )
    );
    if (unregisteredCallbacks.length > 0) {
      // Each unregistered callback also needs its origin allowed, when that is not yet the case.
      const neededOrigins = unique(
        unregisteredCallbacks
          .flatMap((url) => originOf(url) ?? [])
          .filter((origin) => !application.allowed_origins.includes(origin))
      );
      add({
        code: "callback_mismatch",
        severity: "error",
        message: `Callback URLs not registered: [${list(unregisteredCallbacks)}]. Registered: [${list(application.redirect_uris)}].`,
        action: updateCommand([
          ...unregisteredCallbacks.map((url) => `--add-redirect-uri ${url}`),
          ...neededOrigins.map((origin) => `--add-origin ${origin}`)
        ])
      });
    }
    const unregisteredOrigins = unique(
      missing(project?.allowedOrigins ?? [], application.allowed_origins)
    );
    if (unregisteredOrigins.length > 0) {
      add({
        code: "origin_mismatch",
        severity: "error",
        message: `Origins not registered: [${list(unregisteredOrigins)}]. Registered: [${list(application.allowed_origins)}].`,
        action: updateCommand(unregisteredOrigins.map((origin) => `--add-origin ${origin}`))
      });
    }

    // 8. Environment.
    if (project !== null && project.environment !== application.environment) {
      add({
        code: "environment_mismatch",
        severity: "warning",
        message: `enlitt.json says ${project.environment} but the application is ${application.environment}.`,
        action: "Run `enlitt setup` to rewrite enlitt.json from the registered application."
      });
    }
  }

  return findings;
}
