import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { runDoctor } from "./doctor.js";
import type { Finding } from "./doctor.js";
import {
  appDetail,
  contextFor,
  errorBody,
  keyMetadata,
  loginAs,
  makeWorld,
  SENTINEL_SECRET,
  standardRoutes
} from "./test-harness.js";
import type { Handler, World } from "./test-harness.js";

let world: World;

beforeEach(async () => {
  world = await makeWorld();
  await loginAs(world);
  world.handler = standardRoutes();
});

const PROJECT = {
  applicationId: "app_1",
  environment: "test",
  redirectUris: ["https://app.example.com/callback"],
  allowedOrigins: ["https://app.example.com"],
  envFile: ".env.local"
};

/** A project that is entirely healthy: every test below breaks exactly one thing. */
async function healthy(): Promise<void> {
  await world.write("enlitt.json", `${JSON.stringify(PROJECT)}\n`);
  await writeEnv(`ENLITT_CLIENT_ID=enl_client_abc\nENLITT_SECRET_KEY=${SENTINEL_SECRET}\n`);
  world.git.ignored.add(".env.local");
}

async function writeEnv(contents: string): Promise<void> {
  const path = join(world.project, ".env.local");
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function doctor(
  options: { app?: string; envFile?: string; callbackUrls?: string[] } = {}
): Promise<Finding[]> {
  return runDoctor(contextFor(world), {
    app: options.app,
    envFile: options.envFile,
    callbackUrls: options.callbackUrls ?? []
  });
}

const codes = (findings: Finding[]): string[] => findings.map((finding) => finding.code);

function application(overrides: Record<string, unknown>): Handler {
  return standardRoutes((request) =>
    request.path === "/v1/dashboard/business/applications/app_1"
      ? { status: 200, body: appDetail(overrides) }
      : undefined
  );
}

describe("a healthy project", () => {
  it("has no findings", async () => {
    await healthy();
    expect(await doctor()).toEqual([]);
  });
});

describe("one finding per problem", () => {
  it("not_logged_in: reported first, application checks skipped, local checks still run", async () => {
    const anonymous = await makeWorld();
    await anonymous.write("enlitt.json", `${JSON.stringify(PROJECT)}\n`);
    const findings = await runDoctor(contextFor(anonymous), {
      app: undefined,
      envFile: undefined,
      callbackUrls: []
    });
    expect(codes(findings)).toEqual(["not_logged_in", "env_file_missing"]);
    expect(findings[0]).toMatchObject({ severity: "error", action: "Run `enlitt login`." });
    expect(anonymous.requests).toHaveLength(0);
  });

  it("not_logged_in also covers a credential the server no longer accepts", async () => {
    await healthy();
    world.handler = () => ({ status: 401, body: errorBody("not_logged_in") });
    expect(codes(await doctor())).toEqual(["not_logged_in"]);
  });

  it("project_not_linked is a warning and skips the application checks", async () => {
    await writeEnv("ENLITT_CLIENT_ID=x\nENLITT_SECRET_KEY=y\n");
    world.git.ignored.add(".env.local");
    const findings = await doctor();
    expect(codes(findings)).toEqual(["project_not_linked"]);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("application_not_found on a 404", async () => {
    await healthy();
    world.handler = standardRoutes((request) =>
      request.path.endsWith("/applications/app_1")
        ? { status: 404, body: errorBody("not_found") }
        : undefined
    );
    const findings = await doctor();
    expect(codes(findings)).toEqual(["application_not_found"]);
    expect(findings[0]?.severity).toBe("error");
  });

  it("application_not_active", async () => {
    await healthy();
    world.handler = application({ status: "suspended" });
    expect(codes(await doctor())).toEqual(["application_not_active"]);
  });

  it("env_file_missing skips the value checks", async () => {
    await world.write("enlitt.json", `${JSON.stringify(PROJECT)}\n`);
    expect(codes(await doctor())).toEqual(["env_file_missing"]);
  });

  it("env_file_tracked", async () => {
    await healthy();
    world.git.tracked.add(".env.local");
    expect(codes(await doctor())).toEqual(["env_file_tracked"]);
  });

  it("env_file_not_ignored is a warning", async () => {
    await healthy();
    world.git.ignored.clear();
    const findings = await doctor();
    expect(codes(findings)).toEqual(["env_file_not_ignored"]);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("env_file_permissions is a warning", async () => {
    await healthy();
    await chmod(join(world.project, ".env.local"), 0o644);
    const findings = await doctor();
    expect(codes(findings)).toEqual(["env_file_permissions"]);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("client_id_missing", async () => {
    await healthy();
    await writeEnv(`ENLITT_SECRET_KEY=${SENTINEL_SECRET}\n`);
    expect(codes(await doctor())).toEqual(["client_id_missing"]);
  });

  it("client_id_mismatch", async () => {
    await healthy();
    await writeEnv(`ENLITT_CLIENT_ID=enl_client_other\nENLITT_SECRET_KEY=${SENTINEL_SECRET}\n`);
    expect(codes(await doctor())).toEqual(["client_id_mismatch"]);
  });

  it("secret_key_missing", async () => {
    await healthy();
    await writeEnv("ENLITT_CLIENT_ID=enl_client_abc\n");
    expect(codes(await doctor())).toEqual(["secret_key_missing"]);
  });

  it("secret_key_not_active: revoked, wrong scope, and unknown prefix all count, and the value is never output", async () => {
    await healthy();
    for (const keys of [
      [keyMetadata({ status: "revoked" })],
      [keyMetadata({ scope: "reporting", environment: null, application_id: null })],
      [keyMetadata({ prefix: "enl_test_DIFFERENT" })]
    ]) {
      world.handler = application({ api_keys: keys });
      const findings = await doctor();
      expect(codes(findings)).toEqual(["secret_key_not_active"]);
      expect(JSON.stringify(findings)).not.toContain(SENTINEL_SECRET);
      expect(JSON.stringify(findings)).not.toContain("SENTINEL");
    }
  });

  it("callback_mismatch uses --callback-url and enlitt.json, and names both lists", async () => {
    await healthy();
    const fromFlag = await doctor({ callbackUrls: ["https://other.example.com/cb"] });
    expect(codes(fromFlag)).toEqual(["callback_mismatch"]);
    expect(fromFlag[0]?.message).toContain("https://other.example.com/cb");
    expect(fromFlag[0]?.message).toContain("https://app.example.com/callback");
    await world.write(
      "enlitt.json",
      `${JSON.stringify({ ...PROJECT, redirectUris: ["https://app.example.com/nope"] })}\n`
    );
    expect(codes(await doctor())).toEqual(["callback_mismatch"]);
  });

  it("callback_mismatch names only the unregistered URL and gives the filled-in command", async () => {
    await healthy();
    world.handler = application({
      redirect_uris: ["http://localhost:3000/cb"],
      allowed_origins: ["http://localhost:3000"]
    });
    await world.write(
      "enlitt.json",
      `${JSON.stringify({ ...PROJECT, redirectUris: ["http://localhost:3000/cb"], allowedOrigins: ["http://localhost:3000"] })}\n`
    );
    const findings = await doctor({ callbackUrls: ["http://localhost:3001/cb"] });
    expect(codes(findings)).toEqual(["callback_mismatch"]);
    const [before, registered] = findings[0]!.message.split("Registered:");
    expect(before).toContain(":3001");
    expect(before).not.toContain(":3000");
    expect(registered).toContain("http://localhost:3000/cb");
    expect(findings[0]?.action).toBe(
      "npx enlitt app update --add-redirect-uri http://localhost:3001/cb --add-origin http://localhost:3001"
    );
  });

  it("callback_mismatch on staging ends the command with --env staging, and skips an origin already allowed", async () => {
    await loginAs(world, undefined, undefined, "staging");
    await healthy();
    world.handler = application({
      redirect_uris: ["http://localhost:3000/cb"],
      allowed_origins: ["http://localhost:3000", "http://localhost:3001"]
    });
    await world.write(
      "enlitt.json",
      `${JSON.stringify({ ...PROJECT, redirectUris: [], allowedOrigins: [] })}\n`
    );
    const findings = await runDoctor(contextFor(world, { env: "staging" }), {
      app: undefined,
      envFile: undefined,
      callbackUrls: ["http://localhost:3001/cb"]
    });
    expect(codes(findings)).toEqual(["callback_mismatch"]);
    expect(findings[0]?.action).toBe(
      "npx enlitt app update --add-redirect-uri http://localhost:3001/cb --env staging"
    );
  });

  it("origin_mismatch names only the unregistered origin and gives the filled-in command", async () => {
    await healthy();
    await world.write(
      "enlitt.json",
      `${JSON.stringify({ ...PROJECT, allowedOrigins: ["https://app.example.com", "https://elsewhere.example.com"] })}\n`
    );
    const findings = await doctor();
    expect(codes(findings)).toEqual(["origin_mismatch"]);
    const [before] = findings[0]!.message.split("Registered:");
    expect(before).toContain("https://elsewhere.example.com");
    expect(before).not.toContain("https://app.example.com");
    expect(findings[0]?.action).toBe(
      "npx enlitt app update --add-origin https://elsewhere.example.com"
    );
  });

  it("a mismatch for an application given only by --app names the ID in the command", async () => {
    await healthy();
    await world.write(
      "enlitt.json",
      `${JSON.stringify({ ...PROJECT, applicationId: "app_other" })}\n`
    );
    const findings = await doctor({ app: "app_1", callbackUrls: ["https://new.example.com/cb"] });
    const mismatch = findings.find((finding) => finding.code === "callback_mismatch");
    expect(mismatch?.action).toBe(
      "npx enlitt app update app_1 --add-redirect-uri https://new.example.com/cb --add-origin https://new.example.com"
    );
  });

  it("origin_mismatch", async () => {
    await healthy();
    await world.write(
      "enlitt.json",
      `${JSON.stringify({ ...PROJECT, allowedOrigins: ["https://elsewhere.example.com"] })}\n`
    );
    expect(codes(await doctor())).toEqual(["origin_mismatch"]);
  });

  it("environment_mismatch is a warning", async () => {
    await healthy();
    await world.write("enlitt.json", `${JSON.stringify({ ...PROJECT, environment: "live" })}\n`);
    const findings = await doctor();
    expect(codes(findings)).toEqual(["environment_mismatch"]);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("--app overrides the linked application and --env-file overrides the file", async () => {
    await healthy();
    const findings = await doctor({ app: "app_1", envFile: "custom.env" });
    expect(codes(findings)).toEqual(["env_file_missing"]);
    expect(findings[0]?.message).toContain("custom.env");
  });

  it("findings come out in the documented order when several apply", async () => {
    await healthy();
    world.git.tracked.add(".env.local");
    await writeEnv("OTHER=1\n");
    await world.write("enlitt.json", `${JSON.stringify({ ...PROJECT, environment: "live" })}\n`);
    expect(codes(await doctor({ callbackUrls: ["https://x.example.com/cb"] }))).toEqual([
      "env_file_tracked",
      "client_id_missing",
      "secret_key_missing",
      "callback_mismatch",
      "environment_mismatch"
    ]);
  });

  it("an unexpected server failure propagates instead of becoming a finding", async () => {
    await healthy();
    world.handler = standardRoutes((request) =>
      request.path.endsWith("/applications/app_1")
        ? { status: 500, body: errorBody("server_error") }
        : undefined
    );
    await expect(doctor()).rejects.toMatchObject({ code: "server_error" });
  });
});

describe("doctor command output", () => {
  it("exits 0 with ok:true for a healthy project, and warnings alone do not fail it", async () => {
    await healthy();
    const clean = await world.run(["doctor", "--json"]);
    expect(clean.code).toBe(0);
    expect(clean.json).toEqual({ ok: true, findings: [] });
    expect((await world.run(["doctor"])).stdout).toContain("No problems found.");
    world.git.ignored.clear();
    const warned = await world.run(["doctor", "--json"]);
    expect(warned.code).toBe(0);
    expect(warned.json).toMatchObject({ ok: true, findings: [{ code: "env_file_not_ignored" }] });
  });

  it("exits 1 for an error finding and never prints the local secret, in either mode", async () => {
    await healthy();
    world.handler = application({ api_keys: [keyMetadata({ status: "revoked" })] });
    const json = await world.run(["doctor", "--json"]);
    expect(json.code).toBe(1);
    expect(json.json).toMatchObject({
      ok: false,
      findings: [{ code: "secret_key_not_active", severity: "error" }]
    });
    const human = await world.run(["doctor"]);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain("error: secret_key_not_active");
    expect(human.stdout).toContain("next: ");
    for (const result of [json, human]) {
      expect(result.stdout).not.toContain(SENTINEL_SECRET);
      expect(result.stderr).not.toContain(SENTINEL_SECRET);
    }
  });
});
