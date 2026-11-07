import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { BUSINESS_PERMISSIONS } from "@enlitt/protocol";

import { COMMAND_PERMISSIONS, COMMANDS } from "./commands.js";
import {
  appDetail,
  appSummary,
  businessInfo,
  errorBody,
  keyMetadata,
  loginAs,
  makeWorld,
  mutations,
  SENTINEL_CLI_TOKEN,
  SENTINEL_SECRET,
  standardRoutes
} from "./test-harness.js";
import type { Handler, RunResult, World } from "./test-harness.js";

let world: World;

beforeEach(async () => {
  world = await makeWorld();
  await loginAs(world);
});

/** Routes for key minting and rotation that answer with the sentinel secret. */
function keyRoutes(extra: Handler = () => undefined): Handler {
  return standardRoutes((request) => {
    const given = extra(request);
    if (given !== undefined) return given;
    if (request.method === "POST" && request.path === "/v1/dashboard/business/keys") {
      return {
        status: 201,
        body: { metadata: keyMetadata({ id: "key_new" }), secret: SENTINEL_SECRET }
      };
    }
    if (request.method === "POST" && request.path.endsWith("/rotate")) {
      return {
        status: 200,
        body: { metadata: keyMetadata({ id: "key_new" }), secret: SENTINEL_SECRET }
      };
    }
    if (request.method === "GET" && request.path === "/v1/dashboard/business/keys") {
      return {
        status: 200,
        body: [
          keyMetadata({ id: "key_new" }),
          keyMetadata({ id: "key_1", expires_at: "2026-06-22T00:00:00Z" })
        ]
      };
    }
    return undefined;
  });
}

/** Everything the run wrote anywhere a person or agent could read it. */
async function everythingPrinted(result: RunResult): Promise<string> {
  const project = await readFile(join(world.project, "enlitt.json"), "utf8").catch(() => "");
  return `${result.stdout}\n${result.stderr}\n${project}`;
}

describe("--json yields exactly one document for successes and errors", () => {
  it("prints a parseable document for read commands", async () => {
    world.handler = standardRoutes();
    for (const argv of [
      ["whoami"],
      ["status"],
      ["app", "list"],
      ["app", "show", "app_1"],
      ["key", "list"],
      ["business", "info"],
      ["traffic"],
      ["logout"]
    ]) {
      world.handler = standardRoutes((request) =>
        request.method === "DELETE" ? { status: 204 } : undefined
      );
      await loginAs(world);
      const result = await world.run([...argv, "--json"]);
      expect(result.code, argv.join(" ")).toBe(0);
      expect(result.json, argv.join(" ")).toBeDefined();
      expect(result.stdout.trim().split("\n"), argv.join(" ")).toHaveLength(1);
    }
  });

  it("prints {error:{code,message,action}} on stdout for a server refusal", async () => {
    world.handler = () => ({ status: 403, body: errorBody("insufficient_permissions", "No.") });
    const result = await world.run(["whoami", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.json).toMatchObject({
      error: { code: "insufficient_permissions", message: "No." }
    });
    expect((result.json as { error: { action: string } }).error.action).toContain("business owner");
  });

  it("prints error and next lines on stderr without --json", async () => {
    world.handler = () => ({ status: 403, body: errorBody("insufficient_permissions", "No.") });
    const result = await world.run(["whoami"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^error: No\.\nnext: /);
  });

  it("renders a usage error as exit 2, also with --json", async () => {
    const plain = await world.run(["nonsense"]);
    expect(plain.code).toBe(2);
    const json = await world.run(["nonsense", "--json"]);
    expect(json.code).toBe(2);
    expect(json.json).toMatchObject({ error: { code: "usage_error" } });
  });

  it("renders an unexpected exception as internal_error without a stack", async () => {
    world.handler = () => {
      throw new Error("boom");
    };
    const result = await world.run(["whoami"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error:");
    expect(result.stderr).not.toContain(" at ");
  });

  it("not logged in is exit 1 with the login action", async () => {
    const empty = await makeWorld();
    const result = await empty.run(["whoami", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({
      error: { code: "not_logged_in", action: "Run `npx enlitt login`." }
    });
  });
});

describe("environment and origin", () => {
  it("uses the production origin by default and staging with --env", async () => {
    world.handler = standardRoutes();
    await world.run(["whoami"]);
    expect(world.requests[0]?.headers.authorization).toBe(`Bearer ${SENTINEL_CLI_TOKEN}`);
    const staging = await world.run(["whoami", "--env", "staging"]);
    // The production credential is never sent to staging.
    expect(staging.code).toBe(1);
    expect(staging.stderr).toContain("not logged in");
  });

  it("refuses a non-loopback http origin override as a usage error", async () => {
    world.env.ENLITT_CLI_API_ORIGIN = "http://evil.example.com";
    const result = await world.run(["whoami"]);
    expect(result.code).toBe(2);
  });

  it("accepts an https or loopback http override", async () => {
    world.env.ENLITT_CLI_API_ORIGIN = "http://127.0.0.1:8787";
    world.handler = standardRoutes();
    const result = await world.run(["whoami"]);
    // The credential is for another origin, so this is not logged in rather than a usage error.
    expect(result.code).toBe(1);
    world.env.ENLITT_CLI_API_ORIGIN = "https://example.com";
    expect((await world.run(["whoami"])).code).toBe(1);
  });

  it("rejects an unknown --env value", async () => {
    expect((await world.run(["whoami", "--env", "dev"])).code).toBe(2);
  });
});

describe("read commands", () => {
  it("whoami prints login, business, role, permissions, and expiry", async () => {
    world.handler = standardRoutes();
    const result = await world.run(["whoami", "--json"]);
    expect(result.json).toMatchObject({
      login: { email: "dev@example.com" },
      business: {
        id: "biz_1",
        name: "Acme Games",
        role: "owner",
        permissions: [...BUSINESS_PERMISSIONS],
        allowed_commands: Object.keys(COMMAND_PERMISSIONS)
      },
      environment: "production",
      api_origin: "https://api.enlitt.com",
      credential_expires_at: "2027-01-01T00:00:00Z"
    });
  });

  it("status works logged out and reports presence only", async () => {
    const out = await makeWorld();
    const loggedOut = await out.run(["status", "--json"]);
    expect(loggedOut.code).toBe(0);
    expect(loggedOut.json).toMatchObject({ logged_in: false, project: { linked: false } });

    world.handler = standardRoutes();
    await world.write(
      "enlitt.json",
      `${JSON.stringify({ applicationId: "app_1", environment: "test", redirectUris: [], allowedOrigins: [], envFile: ".env.local" })}\n`
    );
    await world.write(".env.local", `ENLITT_SECRET_KEY=${SENTINEL_SECRET}\n`);
    const result = await world.run(["status", "--json"]);
    expect(result.json).toMatchObject({
      logged_in: true,
      project: {
        linked: true,
        application_id: "app_1",
        env_file: ".env.local",
        env_file_has: { ENLITT_SECRET_KEY: true, ENLITT_CLIENT_ID: false }
      }
    });
    expect(result.stdout).not.toContain(SENTINEL_SECRET);
  });

  it("business info follows cursors for application_count and states blocked payout in words", async () => {
    world.handler = standardRoutes((request) => {
      if (request.path === "/v1/dashboard/business") {
        return request.query.get("cursor") === "c2"
          ? {
              status: 200,
              body: businessInfo({ applications: [appSummary({ id: "app_3" })], next_cursor: null })
            }
          : {
              status: 200,
              body: businessInfo({
                applications: [appSummary(), appSummary({ id: "app_2" })],
                next_cursor: "c2"
              })
            };
      }
      return undefined;
    });
    const json = await world.run(["business", "info", "--json"]);
    expect(json.json).toMatchObject({
      application_count: 3,
      payout: { eligible: false },
      earnings: { earnings_nano_usd: "2500000000" }
    });
    const human = await world.run(["business", "info"]);
    expect(human.stdout).toContain("$2.5");
    expect(human.stdout).toContain(
      "not eligible, because the available balance is below the minimum"
    );
  });

  it("business info sends the inclusive range as a half-open one", async () => {
    world.handler = standardRoutes();
    await world.run(["business", "info", "--from", "2026-06-01", "--to", "2026-06-10"]);
    const request = world.requests.find((r) => r.path === "/v1/dashboard/business");
    expect(request?.query.get("from")).toBe("2026-06-01T00:00:00Z");
    expect(request?.query.get("to")).toBe("2026-06-11T00:00:00Z");
  });

  it("app list reports active key counts", async () => {
    world.handler = standardRoutes();
    const result = await world.run(["app", "list", "--json"]);
    expect(result.json).toEqual({
      applications: [
        {
          id: "app_1",
          name: "Web",
          environment: "test",
          status: "active",
          client_id: "enl_client_abc",
          active_key_count: 1
        }
      ]
    });
  });

  it("app show omits analytics and defaults to the linked application", async () => {
    world.handler = standardRoutes();
    expect((await world.run(["app", "show", "--json"])).json).toMatchObject({
      error: { code: "project_not_linked" }
    });
    await world.write(
      "enlitt.json",
      `${JSON.stringify({ applicationId: "app_1", environment: "test", redirectUris: [], allowedOrigins: [], envFile: ".env.local" })}\n`
    );
    const result = await world.run(["app", "show", "--json"]);
    expect(result.json).toMatchObject({ id: "app_1", client_id: "enl_client_abc" });
    expect(result.json).not.toHaveProperty("analytics");
  });

  it("key list reads model keys from the stats reads and reporting keys from /keys", async () => {
    world.handler = keyRoutes();
    const model = await world.run(["key", "list", "--json"]);
    expect(model.json).toMatchObject({ keys: [{ id: "key_1" }] });
    expect(world.requests.every((r) => r.path !== "/v1/dashboard/business/keys")).toBe(true);
    const reporting = await world.run(["key", "list", "--scope", "reporting", "--json"]);
    expect(reporting.code).toBe(0);
    expect(world.requests.at(-1)?.query.get("scope")).toBe("reporting");
    expect((await world.run(["key", "list", "--scope", "reporting", "--app", "app_1"])).code).toBe(
      2
    );
  });

  it("key list --scope accepts app, read-only, model and reporting, and rejects others", async () => {
    world.handler = keyRoutes();
    for (const [value, wire] of [
      ["app", null],
      ["model", null],
      ["read-only", "reporting"],
      ["reporting", "reporting"]
    ] as const) {
      const result = await world.run(["key", "list", "--scope", value, "--json"]);
      expect(result.code, value).toBe(0);
      expect(world.requests.at(-1)?.query.get("scope") ?? null, value).toBe(wire);
    }
    const bad = await world.run(["key", "list", "--scope", "bogus", "--json"]);
    expect(bad.code).toBe(2);
    const message = (bad.json as { error: { message: string } }).error.message;
    for (const name of ["app", "read-only", "model", "reporting"]) expect(message).toContain(name);
  });

  it("key list human output shows the scope label while --json keeps the wire value", async () => {
    world.handler = keyRoutes();
    const human = await world.run(["key", "list"]);
    expect(human.stdout).toContain("App key");
    expect(human.stdout).not.toMatch(/\bmodel\b/);
    const json = await world.run(["key", "list", "--json"]);
    expect(json.json).toMatchObject({ keys: [{ scope: "model" }] });
  });
});

describe("app create and update", () => {
  it("creates a test application and links the project", async () => {
    world.handler = standardRoutes((request) =>
      request.method === "POST" ? { status: 201, body: appDetail({ id: "app_9" }) } : undefined
    );
    const result = await world.run([
      "app",
      "create",
      "--name",
      "Web",
      "--environment",
      "test",
      "--redirect-uri",
      "https://app.example.com/callback",
      "--origin",
      "https://app.example.com",
      "--link",
      "--json"
    ]);
    expect(result.code).toBe(0);
    expect(world.requests.find((r) => r.method === "POST")?.body).toEqual({
      name: "Web",
      environment: "test",
      redirect_uris: ["https://app.example.com/callback"],
      allowed_origins: ["https://app.example.com"]
    });
    expect(result.json).not.toHaveProperty("analytics");
    const project = JSON.parse(await world.read("enlitt.json")) as Record<string, unknown>;
    expect(project).toEqual({
      applicationId: "app_9",
      environment: "test",
      redirectUris: ["https://app.example.com/callback"],
      allowedOrigins: ["https://app.example.com"],
      envFile: ".env.local"
    });
  });

  it("update computes add and remove forms from the current detail and refreshes enlitt.json", async () => {
    await world.write(
      "enlitt.json",
      `${JSON.stringify({ applicationId: "app_1", environment: "test", redirectUris: [], allowedOrigins: [], envFile: ".env.local" })}\n`
    );
    world.handler = standardRoutes((request) =>
      request.method === "PATCH"
        ? {
            status: 200,
            body: appDetail({ redirect_uris: ["https://new.example.com/cb"], allowed_origins: [] })
          }
        : undefined
    );
    const result = await world.run([
      "app",
      "update",
      "--add-redirect-uri",
      "https://new.example.com/cb",
      "--remove-redirect-uri",
      "https://app.example.com/callback",
      "--origin",
      "https://x.example.com",
      "--json"
    ]);
    // --origin replaces a list, which is fine alone.
    expect(result.code).toBe(0);
    const patch = world.requests.find((r) => r.method === "PATCH");
    expect(patch?.body).toEqual({
      redirect_uris: ["https://new.example.com/cb"],
      allowed_origins: ["https://x.example.com"]
    });
    const project = JSON.parse(await world.read("enlitt.json")) as { redirectUris: string[] };
    expect(project.redirectUris).toEqual(["https://new.example.com/cb"]);
  });

  it("mixing a replace form with an add or remove form exits 2 and sends nothing", async () => {
    world.handler = standardRoutes();
    const result = await world.run([
      "app",
      "update",
      "app_1",
      "--redirect-uri",
      "https://a.example/cb",
      "--add-redirect-uri",
      "https://b.example/cb"
    ]);
    expect(result.code).toBe(2);
    expect(mutations(world)).toHaveLength(0);
    const origins = await world.run([
      "app",
      "update",
      "app_1",
      "--origin",
      "https://a.example",
      "--remove-origin",
      "https://b.example"
    ]);
    expect(origins.code).toBe(2);
    expect((await world.run(["app", "update", "app_1"])).code).toBe(2);
    expect(
      (
        await world.run([
          "app",
          "update",
          "app_1",
          "--icon-url",
          "https://a.example/i.png",
          "--clear-icon-url"
        ])
      ).code
    ).toBe(2);
  });

  it("clearing the icon sends null", async () => {
    world.handler = standardRoutes((request) =>
      request.method === "PATCH" ? { status: 200, body: appDetail() } : undefined
    );
    await world.run(["app", "update", "app_1", "--clear-icon-url"]);
    expect(world.requests.find((r) => r.method === "PATCH")?.body).toEqual({ icon_url: null });
  });
});

describe("app premium", () => {
  const PREMIUM_PATH = "/v1/dashboard/business/applications/app_1/premium";

  /** Answers the detail read with `before` and the PUT with the requested value. */
  function premiumRoutes(before: Record<string, unknown> = {}): Handler {
    return standardRoutes((request) => {
      if (request.method === "GET" && request.path === "/v1/dashboard/business/applications/app_1")
        return { status: 200, body: appDetail(before) };
      if (request.method === "PUT" && request.path === PREMIUM_PATH) {
        const enabled = (request.body as { enabled: boolean }).enabled;
        return { status: 200, body: appDetail({ ...before, premium_enabled: enabled }) };
      }
      return undefined;
    });
  }

  it("--on sends PUT { enabled: true } and prints { application, changed }", async () => {
    world.handler = premiumRoutes({ premium_enabled: false });
    const result = await world.run(["app", "premium", "app_1", "--on", "--json"]);
    expect(result.code).toBe(0);
    expect(mutations(world)).toEqual([
      expect.objectContaining({ method: "PUT", path: PREMIUM_PATH, body: { enabled: true } })
    ]);
    expect(result.json).toEqual({
      application: { id: "app_1", name: "Web", environment: "test", premium_enabled: true },
      changed: true
    });
  });

  it("reports changed: false when the application already held the value", async () => {
    world.handler = premiumRoutes({ premium_enabled: true });
    const result = await world.run(["app", "premium", "app_1", "--on", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ changed: false });
  });

  it("--off on a test application needs no --confirm", async () => {
    world.handler = premiumRoutes();
    const result = await world.run(["app", "premium", "app_1", "--off", "--json"]);
    expect(result.code).toBe(0);
    expect(mutations(world)[0]?.body).toEqual({ enabled: false });
    expect(result.json).toMatchObject({ application: { premium_enabled: false }, changed: true });
  });

  it("--off on a live application without --confirm is confirmation_required and sends no PUT", async () => {
    world.handler = premiumRoutes({ environment: "live" });
    const result = await world.run(["app", "premium", "app_1", "--off", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: { code: "confirmation_required" } });
    expect(mutations(world)).toHaveLength(0);
  });

  it("--off on a live application with --confirm sends the PUT", async () => {
    world.handler = premiumRoutes({ environment: "live" });
    const result = await world.run(["app", "premium", "app_1", "--off", "--confirm", "--json"]);
    expect(result.code).toBe(0);
    expect(mutations(world)[0]?.body).toEqual({ enabled: false });
  });

  it.each([
    ["neither flag", ["app", "premium", "app_1"]],
    ["both flags", ["app", "premium", "app_1", "--on", "--off"]]
  ])("%s is a usage_error (exit 2) with no request", async (_name, argv) => {
    world.handler = premiumRoutes();
    const result = await world.run([...argv, "--json"]);
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ error: { code: "usage_error" } });
    expect(world.requests).toHaveLength(0);
  });

  it("defaults the ID to the linked application in enlitt.json", async () => {
    await world.write(
      "enlitt.json",
      `${JSON.stringify({ applicationId: "app_1", environment: "test", redirectUris: [], allowedOrigins: [], envFile: ".env.local" })}\n`
    );
    world.handler = premiumRoutes({ premium_enabled: false });
    const result = await world.run(["app", "premium", "--on", "--json"]);
    expect(result.code).toBe(0);
    expect(mutations(world)[0]?.path).toBe(PREMIUM_PATH);
  });

  it("the human form states the new state, and --on adds that each user's limit starts at zero", async () => {
    world.handler = premiumRoutes({ premium_enabled: false });
    const result = await world.run(["app", "premium", "app_1", "--on"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Premium credit is now on for Web (app_1).");
    expect(result.stdout).toContain(
      "Each user's premium limit starts at zero until the user raises it."
    );
  });

  it("app show prints premium_enabled with the rest of the detail", async () => {
    world.handler = premiumRoutes({ premium_enabled: false });
    const json = await world.run(["app", "show", "app_1", "--json"]);
    expect(json.json).toMatchObject({ premium_enabled: false });
    const text = await world.run(["app", "show", "app_1"]);
    expect(text.stdout).toMatch(/premium credit:\s+off/);
  });

  it("a server premium_not_enabled prints the action from the table", async () => {
    world.handler = standardRoutes((request) =>
      request.method === "GET" && request.path === "/v1/dashboard/business/applications/app_1"
        ? { status: 403, body: errorBody("premium_not_enabled", "Premium credit is not enabled.") }
        : undefined
    );
    const result = await world.run(["app", "show", "app_1", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({
      error: {
        code: "premium_not_enabled",
        action:
          "Premium credit is off for this app. An owner or admin can run `npx enlitt app premium <id> --on`."
      }
    });
  });
});

describe("destination and confirmation gating", () => {
  const gated: [string, string[], string][] = [
    [
      "key create without a destination",
      ["key", "create", "--app", "app_1", "--name", "n"],
      "secret_destination_required"
    ],
    ["key revoke without --confirm", ["key", "revoke", "key_1"], "confirmation_required"],
    [
      "app create --environment live without --confirm",
      ["app", "create", "--name", "n", "--environment", "live"],
      "confirmation_required"
    ]
  ];
  it.each(gated)("%s exits 1 with its code and sends no mutation", async (_name, argv, code) => {
    world.handler = keyRoutes();
    const result = await world.run([...argv, "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: { code } });
    expect(mutations(world)).toHaveLength(0);
  });

  it("a live key rotate without --confirm is confirmation_required before the rotate", async () => {
    world.handler = keyRoutes((request) =>
      request.path === "/v1/dashboard/business" && request.method === "GET"
        ? {
            status: 200,
            body: businessInfo({
              applications: [
                appSummary({
                  environment: "live",
                  api_keys: [keyMetadata({ environment: "live" })]
                })
              ]
            })
          }
        : undefined
    );
    const result = await world.run([
      "key",
      "rotate",
      "key_1",
      "--write-env",
      ".env.local",
      "--json"
    ]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: { code: "confirmation_required" } });
    expect(mutations(world)).toHaveLength(0);
  });

  it("--reveal is a usage error with --json and refused off a terminal", async () => {
    world.handler = keyRoutes();
    expect(
      (await world.run(["key", "create", "--app", "app_1", "--name", "n", "--reveal", "--json"]))
        .code
    ).toBe(2);
    const notTty = await world.run(["key", "create", "--app", "app_1", "--name", "n", "--reveal"]);
    expect(notTty.code).toBe(1);
    expect(notTty.stderr).toContain("terminal");
    expect(mutations(world)).toHaveLength(0);
  });

  it("key create needs exactly one of --app and --scope reporting, and a name", async () => {
    world.handler = keyRoutes();
    expect(
      (await world.run(["key", "create", "--name", "n", "--write-env", ".env.local"])).code
    ).toBe(2);
    expect(
      (
        await world.run([
          "key",
          "create",
          "--app",
          "app_1",
          "--scope",
          "reporting",
          "--name",
          "n",
          "--write-env",
          ".env.local"
        ])
      ).code
    ).toBe(2);
    expect(
      (await world.run(["key", "create", "--app", "app_1", "--write-env", ".env.local"])).code
    ).toBe(2);
    expect(mutations(world)).toHaveLength(0);
  });

  it("refuses before minting when the destination is a tracked file or already holds the key", async () => {
    world.handler = keyRoutes();
    world.git.tracked.add(".env.local");
    await world.write(".env.local", "A=1\n");
    const tracked = await world.run([
      "key",
      "create",
      "--app",
      "app_1",
      "--name",
      "n",
      "--write-env",
      ".env.local",
      "--json"
    ]);
    expect(tracked.json).toMatchObject({ error: { code: "env_file_tracked" } });
    world.git.tracked.clear();
    await world.write(".env.local", `ENLITT_SECRET_KEY=old_value_here\n`);
    const exists = await world.run([
      "key",
      "create",
      "--app",
      "app_1",
      "--name",
      "n",
      "--write-env",
      ".env.local",
      "--json"
    ]);
    expect(exists.json).toMatchObject({ error: { code: "env_key_exists" } });
    expect(mutations(world)).toHaveLength(0);
  });
});

describe("secret containment", () => {
  for (const json of [false, true]) {
    const flags = json ? ["--json"] : [];

    it(`key create keeps the secret out of all output (json=${json})`, async () => {
      world.handler = keyRoutes();
      const result = await world.run([
        "key",
        "create",
        "--app",
        "app_1",
        "--name",
        "web",
        "--write-env",
        ".env.local",
        ...flags
      ]);
      expect(result.code).toBe(0);
      expect(await world.read(".env.local")).toBe(`ENLITT_SECRET_KEY=${SENTINEL_SECRET}\n`);
      expect(await everythingPrinted(result)).not.toContain(SENTINEL_SECRET);
      expect(await everythingPrinted(result)).not.toContain(SENTINEL_CLI_TOKEN);
      if (json)
        expect(result.json).toMatchObject({
          key: { id: "key_new" },
          secret_written_to: { file: ".env.local", variable: "ENLITT_SECRET_KEY" },
          gitignored: true
        });
      expect(((await stat(join(world.project, ".env.local"))).mode & 0o777).toString(8)).toBe(
        "600"
      );
      expect(await world.read(".gitignore")).toContain("/.env.local");
    });

    it(`key rotate keeps the secret out of all output (json=${json})`, async () => {
      world.handler = keyRoutes();
      await world.write(".env.local", "OTHER=1\nENLITT_SECRET_KEY=old_value_here\n");
      const result = await world.run([
        "key",
        "rotate",
        "key_1",
        "--write-env",
        ".env.local",
        ...flags
      ]);
      expect(result.code).toBe(0);
      expect(await world.read(".env.local")).toBe(
        `OTHER=1\nENLITT_SECRET_KEY=${SENTINEL_SECRET}\n`
      );
      expect(await everythingPrinted(result)).not.toContain(SENTINEL_SECRET);
      if (json) {
        expect(result.json).toMatchObject({
          key: { id: "key_new" },
          previous_key: { id: "key_1", expires_at: "2026-06-22T00:00:00Z" }
        });
      } else {
        expect(result.stdout).toContain("2026-06-22T00:00:00Z");
      }
    });

    it(`setup keeps the secret out of all output (json=${json})`, async () => {
      world.handler = keyRoutes();
      const result = await world.run(["setup", "--app", "app_1", ...flags]);
      expect(result.code).toBe(0);
      const env = await world.read(".env.local");
      expect(env).toContain(`ENLITT_SECRET_KEY=${SENTINEL_SECRET}`);
      expect(env).toContain("ENLITT_CLIENT_ID=enl_client_abc");
      expect(await everythingPrinted(result)).not.toContain(SENTINEL_SECRET);
      if (json)
        expect(result.json).toMatchObject({
          wrote: ["ENLITT_CLIENT_ID", "ENLITT_SECRET_KEY"],
          project_file: "enlitt.json"
        });
    });
  }

  it("--reveal prints the secret only on a TTY and without --json", async () => {
    world.handler = keyRoutes();
    world.isTTY = { stdin: true, stdout: true, stderr: true };
    const result = await world.run([
      "key",
      "create",
      "--app",
      "app_1",
      "--name",
      "web",
      "--reveal"
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(SENTINEL_SECRET);
    expect(result.stderr).not.toContain(SENTINEL_SECRET);
    await expect(readFile(join(world.project, ".env.local"), "utf8")).rejects.toThrow();
  });

  it("a failed env write after minting names the key and never carries the secret", async () => {
    world.handler = keyRoutes((request) => {
      if (request.method === "POST") {
        // The file becomes a tracked one between the pre-check and the write.
        world.git.tracked.add(".env.local");
        return {
          status: 201,
          body: { metadata: keyMetadata({ id: "key_new" }), secret: SENTINEL_SECRET }
        };
      }
      return undefined;
    });
    const result = await world.run([
      "key",
      "create",
      "--app",
      "app_1",
      "--name",
      "web",
      "--write-env",
      ".env.local",
      "--json"
    ]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: { code: "env_file_tracked" } });
    expect(result.stdout).toContain("key_new");
    expect(result.stdout).not.toContain(SENTINEL_SECRET);
  });

  it("the CLI token never appears in output, even when the server echoes it", async () => {
    world.handler = () => ({
      status: 500,
      body: errorBody("server_error", `leaked ${SENTINEL_CLI_TOKEN}`)
    });
    const result = await world.run(["whoami"]);
    expect(result.stderr).not.toContain(SENTINEL_CLI_TOKEN);
    expect(result.stderr).toContain("[redacted]");
  });

  it("a server error message echoing the key secret is scrubbed", async () => {
    world.handler = keyRoutes((request) =>
      request.path === "/v1/dashboard/business/keys" && request.method === "GET"
        ? { status: 500, body: errorBody("server_error", `oops ${SENTINEL_SECRET}`) }
        : undefined
    );
    await world.write(".env.local", "ENLITT_SECRET_KEY=old\n");
    const result = await world.run([
      "key",
      "rotate",
      "key_1",
      "--write-env",
      ".env.local",
      "--json"
    ]);
    // The follow-up list failing must not lose or print the secret.
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ previous_key: null });
    expect(await everythingPrinted(result)).not.toContain(SENTINEL_SECRET);
    expect(await world.read(".env.local")).toContain(SENTINEL_SECRET);
  });
});

describe("step-up", () => {
  const reauth: Handler = (request) => {
    if (request.method === "POST" && request.path === "/v1/cli/authorizations") {
      return {
        status: 201,
        body: {
          device_code: "devcode-0123456789abcdef",
          user_code: "BCDF-GHJK",
          verification_uri: "https://enlitt.com/cli/authorize",
          verification_uri_complete: "https://enlitt.com/cli/authorize?code=BCDF-GHJK",
          expires_in: 600,
          interval: 5
        }
      };
    }
    if (request.method === "POST" && request.path === "/v1/cli/token") {
      return { status: 200, body: { kind: "step_up", reauthenticated_at: "2026-06-15T12:00:01Z" } };
    }
    return undefined;
  };

  it("on TTYs, runs reauth inline and retries exactly once", async () => {
    world.isTTY = { stdin: true, stdout: true, stderr: true };
    let creates = 0;
    world.handler = keyRoutes((request) => {
      const flow = reauth(request);
      if (flow !== undefined) return flow;
      if (request.method === "POST" && request.path === "/v1/dashboard/business/keys") {
        creates += 1;
        if (creates === 1) return { status: 403, body: errorBody("reauthentication_required") };
      }
      return undefined;
    });
    const result = await world.run([
      "key",
      "create",
      "--app",
      "app_1",
      "--name",
      "web",
      "--write-env",
      ".env.local"
    ]);
    expect(result.code).toBe(0);
    expect(creates).toBe(2);
    expect(world.browser).toHaveLength(1);
  });

  it("retries only once: a second refusal fails", async () => {
    world.isTTY = { stdin: true, stdout: true, stderr: true };
    let creates = 0;
    world.handler = keyRoutes((request) => {
      const flow = reauth(request);
      if (flow !== undefined) return flow;
      if (request.method === "POST" && request.path === "/v1/dashboard/business/keys") {
        creates += 1;
        return { status: 403, body: errorBody("reauthentication_required") };
      }
      return undefined;
    });
    const result = await world.run([
      "key",
      "create",
      "--app",
      "app_1",
      "--name",
      "web",
      "--write-env",
      ".env.local"
    ]);
    expect(result.code).toBe(1);
    expect(creates).toBe(2);
  });

  it("without TTYs fails with the code and the documented action and sends nothing else", async () => {
    world.handler = keyRoutes((request) =>
      request.method === "POST" && request.path === "/v1/dashboard/business/keys"
        ? { status: 403, body: errorBody("reauthentication_required") }
        : undefined
    );
    const result = await world.run([
      "key",
      "create",
      "--app",
      "app_1",
      "--name",
      "web",
      "--write-env",
      ".env.local",
      "--json"
    ]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: { code: "reauthentication_required" } });
    expect((result.json as { error: { action: string } }).error.action).toContain(
      "enlitt reauth --no-wait"
    );
    expect(mutations(world)).toHaveLength(1);
    expect(world.requests.some((r) => r.path.startsWith("/v1/cli/"))).toBe(false);
  });
});

describe("key revoke, logout", () => {
  it("revoke prints the revoked key from the returned list", async () => {
    world.handler = keyRoutes((request) =>
      request.method === "DELETE"
        ? { status: 200, body: [keyMetadata({ status: "revoked" })] }
        : undefined
    );
    const result = await world.run(["key", "revoke", "key_1", "--confirm", "--json"]);
    expect(result.json).toMatchObject({ revoked: { id: "key_1", status: "revoked" } });
    expect(world.requests.at(-1)?.headers["x-enlitt-business-id"]).toBe("biz_1");
  });

  it("logout revokes, deletes the file, and still deletes it when the call fails", async () => {
    world.handler = () => ({ status: 204 });
    const ok = await world.run(["logout", "--json"]);
    expect(ok.json).toEqual({ logged_out: true, revoked: true });
    expect((await world.run(["logout", "--json"])).json).toEqual({
      logged_out: false,
      revoked: false
    });
    await loginAs(world);
    world.handler = () => ({ status: 500, body: errorBody("server_error") });
    expect((await world.run(["logout", "--json"])).json).toEqual({
      logged_out: true,
      revoked: false
    });
    expect((await world.run(["whoami"])).code).toBe(1);
  });
});

describe("setup", () => {
  it("writes .env and points at the matching docs page for Python and .NET projects", async () => {
    // The harness project starts as a Node project; swap its marker file.
    await rm(join(world.project, "package.json"));
    await world.write("pyproject.toml", "");
    world.handler = keyRoutes();
    const python = await world.run(["setup", "--app", "app_1", "--json"]);
    expect(python.json).toMatchObject({ language: "python", env_file: ".env" });
    expect((python.json as { next: string }).next).toContain("/docs/python.md");
    expect(await world.read(".env")).toContain("ENLITT_CLIENT_ID=");

    await rm(join(world.project, "pyproject.toml"));
    await rm(join(world.project, "enlitt.json"));
    await rm(join(world.project, ".env"));
    await world.write("App.csproj", "");
    world.handler = keyRoutes();
    const dotnet = await world.run(["setup", "--app", "app_1", "--json"]);
    expect(dotnet.json).toMatchObject({ language: "dotnet", env_file: ".env" });
    expect((dotnet.json as { next: string }).next).toContain("/docs/dotnet.md");
  });

  it("writes .env.local for Node, and an explicit --env-file always wins", async () => {
    world.handler = keyRoutes();
    const node = await world.run(["setup", "--app", "app_1", "--json"]);
    expect(node.json).toMatchObject({ language: "node", env_file: ".env.local" });
    expect((node.json as { next: string }).next).toContain("/docs/authentication.md");

    await rm(join(world.project, "package.json"));
    await world.write("requirements.txt", "");
    await rm(join(world.project, "enlitt.json"));
    world.handler = keyRoutes();
    const explicit = await world.run([
      "setup",
      "--app",
      "app_1",
      "--env-file",
      ".env.dev",
      "--json"
    ]);
    expect(explicit.json).toMatchObject({ language: "python", env_file: ".env.dev" });
  });

  it("is idempotent: a rerun keeps the existing secret and mints nothing", async () => {
    world.handler = keyRoutes();
    expect((await world.run(["setup", "--app", "app_1"])).code).toBe(0);
    const before = await world.read(".env.local");
    world.requests.length = 0;
    const second = await world.run(["setup", "--json"]);
    expect(second.code).toBe(0);
    expect(second.json).toMatchObject({ wrote: ["ENLITT_CLIENT_ID"] });
    expect(await world.read(".env.local")).toBe(before);
    expect(mutations(world)).toHaveLength(0);
    // --replace-secret mints a new one.
    await world.run(["setup", "--replace-secret"]);
    expect(mutations(world)).toHaveLength(1);
  });

  it("creates an application from flags when none is linked, and needs --name", async () => {
    world.handler = keyRoutes((request) =>
      request.method === "POST" && request.path === "/v1/dashboard/business/applications"
        ? { status: 201, body: appDetail({ id: "app_7" }) }
        : undefined
    );
    expect((await world.run(["setup"])).code).toBe(2);
    const result = await world.run(["setup", "--name", "Web", "--json"]);
    expect(result.code).toBe(0);
    expect(
      world.requests.find((r) => r.path === "/v1/dashboard/business/applications")?.body
    ).toMatchObject({ name: "Web", environment: "test" });
    expect(JSON.parse(await world.read("enlitt.json"))).toMatchObject({ applicationId: "app_7" });
  });

  it("writes ENLITT_BASE_URL off production", async () => {
    await loginAsStaging();
    world.handler = keyRoutes();
    const result = await world.run(["setup", "--app", "app_1", "--env", "staging", "--json"]);
    expect(result.code).toBe(0);
    expect(await world.read(".env.local")).toContain(
      "ENLITT_BASE_URL=https://staging-api.enlitt.com"
    );
  });

  it("refuses a live creation without --confirm before any request", async () => {
    world.handler = keyRoutes();
    const result = await world.run(["setup", "--name", "Web", "--environment", "live"]);
    expect(result.code).toBe(1);
    expect(mutations(world)).toHaveLength(0);
  });
});

async function loginAsStaging(): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const directory = join(world.config, "enlitt");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "cli-staging.json"),
    JSON.stringify({
      version: 1,
      api_origin: "https://staging-api.enlitt.com",
      token: SENTINEL_CLI_TOKEN,
      credential_id: "c",
      business: { id: "biz_1", name: "Acme Games" },
      login_email: "dev@example.com",
      token_expires_at: "2027-01-01T00:00:00Z"
    }),
    { mode: 0o600 }
  );
}

describe("printed commands and URLs carry the run's environment", () => {
  it("an error action and a hint name --env staging on staging and never on production", async () => {
    // No credential in either environment: not_logged_in, whose action is a command.
    const empty = await makeWorld();
    const staging = await empty.run(["whoami", "--env", "staging", "--json"]);
    const production = await empty.run(["whoami", "--json"]);
    const stagingAction = (staging.json as { error: { action: string } }).error.action;
    const productionAction = (production.json as { error: { action: string } }).error.action;
    expect(stagingAction).toBe("Run `npx enlitt login --env staging`.");
    expect(productionAction).toBe("Run `npx enlitt login`.");
    expect(productionAction).not.toContain("--env");

    // The hint inside `status` output is qualified the same way.
    const stagingStatus = await empty.run(["status", "--env", "staging"]);
    expect(stagingStatus.stdout).toContain("run `npx enlitt login --env staging`");
    expect((await empty.run(["status"])).stdout).not.toContain("--env");
  });

  it("a multi-command action qualifies each command, and the fallback docs URL follows the environment", async () => {
    await loginAsStaging();
    world.handler = () => ({ status: 403, body: errorBody("reauthentication_required") });
    const result = await world.run([
      "key",
      "list",
      "--scope",
      "reporting",
      "--env",
      "staging",
      "--json"
    ]);
    const action = (result.json as { error: { action: string } }).error.action;
    expect(action).toContain("`npx enlitt reauth --no-wait --env staging`");
    expect(action).toContain("`npx enlitt reauth --wait --env staging`");

    world.handler = () => ({ status: 500, body: errorBody("something_unmapped") });
    const unmapped = await world.run(["whoami", "--env", "staging", "--json"]);
    expect((unmapped.json as { error: { action: string } }).error.action).toBe(
      "See https://staging.enlitt.com/docs/errors.md."
    );
  });

  it("a usage error raised before parsing finishes still names the environment", async () => {
    const result = await world.run(["nonsense", "--env", "staging", "--json"]);
    expect(result.code).toBe(2);
    expect((result.json as { error: { action: string } }).error.action).toBe(
      "Run `npx enlitt --help --env staging` for the commands and flags."
    );
  });

  it("setup's next step points at the environment's docs", async () => {
    await loginAsStaging();
    world.handler = keyRoutes();
    const staging = await world.run(["setup", "--app", "app_1", "--env", "staging", "--json"]);
    expect((staging.json as { next: string }).next).toContain(
      "https://staging.enlitt.com/docs/authentication.md"
    );
    expect((staging.json as { next: string }).next).not.toContain("https://enlitt.com");

    world.handler = keyRoutes();
    const production = await world.run(["setup", "--app", "app_1", "--json"]);
    expect((production.json as { next: string }).next).toContain(
      "https://enlitt.com/docs/authentication.md"
    );
  });

  it("the dashboard hints use the environment's site", async () => {
    await loginAsStaging();
    world.handler = keyRoutes();
    const staging = await world.run(["business", "info", "--env", "staging"]);
    expect(staging.stdout).toContain("https://staging.enlitt.com/dashboard/business/members");
    expect(staging.stdout).not.toContain(" https://enlitt.com");
  });
});

describe("--help describes every flag", () => {
  it("one command per group shows descriptions, placeholders, and defaults", async () => {
    const login = (await world.run(["login", "--help"])).stdout;
    expect(login).toContain("--label <text>");
    expect(login).toContain("(default: <hostname> (<platform>))");
    expect(login).toContain("--timeout <seconds>");

    const traffic = (await world.run(["traffic", "--help"])).stdout;
    expect(traffic).toContain("--days <n>");
    expect(traffic).toContain("(default: 30)");
    expect(traffic).not.toMatch(/--app <value>/);

    const keyCreate = (await world.run(["key", "create", "--help"])).stdout;
    expect(keyCreate).toContain("--write-env <file>");
    expect(keyCreate).toContain("ENLITT_REPORTING_KEY");

    const setup = (await world.run(["setup", "--help"])).stdout;
    expect(setup).toContain("(default: .env.local)");
    expect(setup).toContain("--environment test|live");

    const doctor = (await world.run(["doctor", "--help"])).stdout;
    expect(doctor).toContain("--callback-url <url>");
  });

  it("every flag of every command has a description", () => {
    for (const command of COMMANDS) {
      for (const flag of Object.keys(command.flags)) {
        expect(
          command.flagDocs?.[flag]?.description,
          `${command.name.join(" ")} --${flag}`
        ).toBeTruthy();
      }
    }
  });
});
