import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  errorBody,
  loginAs,
  makeWorld,
  SENTINEL_CLI_TOKEN,
  SENTINEL_DEVICE_CODE,
  standardRoutes
} from "./test-harness.js";
import type { Handler, RunResult, World } from "./test-harness.js";

let world: World;

beforeEach(async () => {
  world = await makeWorld();
});

const pendingFile = (): string => join(world.config, "enlitt", "cli-production.pending.json");
const credentialFile = (): string => join(world.config, "enlitt", "cli-production.json");

const started = {
  device_code: SENTINEL_DEVICE_CODE,
  user_code: "BCDF-GHJK",
  verification_uri: "https://enlitt.com/cli/authorize",
  verification_uri_complete: "https://enlitt.com/cli/authorize?code=BCDF-GHJK",
  expires_in: 600,
  interval: 5
};

const loginGrant = {
  kind: "login",
  token: SENTINEL_CLI_TOKEN,
  token_expires_at: "2027-01-01T00:00:00Z",
  credential_id: "cred_new",
  business: { id: "biz_1", name: "Acme Games" },
  login: { email: "dev@example.com" }
};

/** Starts fine, then answers each poll from `polls` in order (the last repeats). */
function flow(
  polls: { status: number; body: unknown }[],
  kind: "login" | "step_up" = "login"
): Handler {
  let index = 0;
  return (request) => {
    if (request.method === "POST" && request.path === "/v1/cli/authorizations") {
      return { status: 201, body: started };
    }
    if (request.method === "POST" && request.path === "/v1/cli/token") {
      const reply = polls[Math.min(index, polls.length - 1)]!;
      index += 1;
      return reply;
    }
    if (kind === "step_up") return standardRoutes()(request);
    return undefined;
  };
}

const pending = { status: 400, body: errorBody("authorization_pending") };
const slowDown = { status: 400, body: errorBody("slow_down") };

function noLeak(result: RunResult, ...secrets: string[]): void {
  for (const secret of secrets) {
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }
}

describe("login", () => {
  it("polls while pending, saves the credential 0600 in a 0700 directory, and deletes the pending file", async () => {
    world.handler = flow([pending, pending, { status: 200, body: loginGrant }]);
    const result = await world.run(["login", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toEqual({
      login: { email: "dev@example.com" },
      business: { id: "biz_1", name: "Acme Games" },
      credential_id: "cred_new",
      expires_at: "2027-01-01T00:00:00Z"
    });
    expect(world.sleeps).toEqual([5000, 5000]);
    const saved = JSON.parse(await readFile(credentialFile(), "utf8")) as {
      token: string;
      api_origin: string;
    };
    expect(saved.token).toBe(SENTINEL_CLI_TOKEN);
    expect(saved.api_origin).toBe("https://api.enlitt.com");
    expect(((await stat(credentialFile())).mode & 0o777).toString(8)).toBe("600");
    expect(((await stat(join(world.config, "enlitt"))).mode & 0o777).toString(8)).toBe("700");
    await expect(stat(pendingFile())).rejects.toThrow();
    // No temp file is left behind.
    expect(await readdir(join(world.config, "enlitt"))).toEqual(["cli-production.json"]);
    noLeak(result, SENTINEL_CLI_TOKEN, SENTINEL_DEVICE_CODE);
  });

  it("prints the URL and code on stderr and opens the browser unless --no-browser", async () => {
    world.handler = flow([{ status: 200, body: loginGrant }]);
    const withBrowser = await world.run(["login"]);
    expect(withBrowser.stderr).toContain("https://enlitt.com/cli/authorize?code=BCDF-GHJK");
    expect(withBrowser.stderr).toContain("BCDF-GHJK");
    expect(world.browser).toEqual(["https://enlitt.com/cli/authorize?code=BCDF-GHJK"]);
    world.browser.length = 0;
    await world.run(["login", "--no-browser"]);
    expect(world.browser).toEqual([]);
  });

  it("sends the label, defaulting to something non-empty", async () => {
    world.handler = flow([{ status: 200, body: loginGrant }]);
    await world.run(["login", "--label", "my laptop"]);
    const start = world.requests.find((r) => r.path === "/v1/cli/authorizations");
    expect(start?.body).toMatchObject({ kind: "login", device_label: "my laptop" });
    // Starting a login is unauthenticated.
    expect(start?.headers.authorization).toBeUndefined();
    await world.run(["login"]);
    const label = (
      world.requests.filter((r) => r.path === "/v1/cli/authorizations").at(-1)?.body as {
        device_label: string;
      }
    ).device_label;
    expect(label.length).toBeGreaterThan(0);
  });

  it("slow_down adds 5 seconds to every later wait", async () => {
    world.handler = flow([pending, slowDown, pending, { status: 200, body: loginGrant }]);
    const result = await world.run(["login", "--json"]);
    expect(result.code).toBe(0);
    expect(world.sleeps).toEqual([5000, 10000, 10000]);
  });

  it("access_denied exits 1 and deletes the pending file", async () => {
    world.handler = flow([pending, { status: 400, body: errorBody("access_denied") }]);
    const result = await world.run(["login", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: { code: "access_denied" } });
    await expect(stat(pendingFile())).rejects.toThrow();
    await expect(stat(credentialFile())).rejects.toThrow();
  });

  it("expired_token from the server exits 1 and deletes the pending file", async () => {
    world.handler = flow([{ status: 400, body: errorBody("expired_token") }]);
    const result = await world.run(["login", "--json"]);
    expect(result.json).toMatchObject({ error: { code: "expired_token" } });
    await expect(stat(pendingFile())).rejects.toThrow();
  });

  it("gives up with expired_token once the clock passes the authorization expiry", async () => {
    world.handler = flow([pending]);
    const result = await world.run(["login", "--json"]);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ error: { code: "expired_token" } });
    await expect(stat(pendingFile())).rejects.toThrow();
  });

  it("--timeout stops polling, keeps the pending file, and --wait resumes", async () => {
    world.handler = flow([pending]);
    const timedOut = await world.run(["login", "--timeout", "12", "--json"]);
    expect(timedOut.code).toBe(1);
    expect(timedOut.json).toMatchObject({ error: { code: "authorization_pending" } });
    expect((timedOut.json as { error: { action: string } }).error.action).toContain(
      "enlitt login --wait"
    );
    expect(((await stat(pendingFile())).mode & 0o777).toString(8)).toBe("600");
    noLeak(timedOut, SENTINEL_DEVICE_CODE);

    world.requests.length = 0;
    world.handler = flow([{ status: 200, body: loginGrant }]);
    const resumed = await world.run(["login", "--wait", "--json"]);
    expect(resumed.code).toBe(0);
    // Resuming does not start a second authorization and reuses the saved device code.
    expect(world.requests.some((r) => r.path === "/v1/cli/authorizations")).toBe(false);
    expect(world.requests.find((r) => r.path === "/v1/cli/token")?.body).toEqual({
      device_code: SENTINEL_DEVICE_CODE
    });
    await expect(stat(pendingFile())).rejects.toThrow();
    expect(JSON.parse(await readFile(credentialFile(), "utf8"))).toMatchObject({
      credential_id: "cred_new"
    });
  });

  it("--no-wait saves the pending file and reports the code without the device code", async () => {
    world.handler = flow([pending]);
    const result = await world.run(["login", "--no-wait", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      status: "pending",
      user_code: "BCDF-GHJK",
      verification_uri_complete: "https://enlitt.com/cli/authorize?code=BCDF-GHJK"
    });
    expect(world.requests.some((r) => r.path === "/v1/cli/token")).toBe(false);
    expect(JSON.parse(await readFile(pendingFile(), "utf8"))).toMatchObject({
      device_code: SENTINEL_DEVICE_CODE,
      kind: "login"
    });
    noLeak(result, SENTINEL_DEVICE_CODE);
    const human = await world.run(["login", "--no-wait"]);
    // Human form: URL and code once, then the next step, all on stderr; stdout stays empty.
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("npx enlitt login --wait");
    noLeak(human, SENTINEL_DEVICE_CODE);
    // The code is announced once (the URL itself also carries it, as verification_uri_complete).
    expect(`${human.stdout}${human.stderr}`.split("the code: BCDF-GHJK")).toHaveLength(2);
    expect(human.stderr.split("https://enlitt.com/cli/authorize")).toHaveLength(2);
  });

  it("--no-wait on staging prints a next step that targets staging", async () => {
    world.handler = flow([pending]);
    const result = await world.run(["login", "--no-wait", "--env", "staging"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("npx enlitt login --wait --env staging");
  });

  it("--wait without a pending file is no_pending_authorization", async () => {
    world.handler = flow([pending]);
    const result = await world.run(["login", "--wait", "--json"]);
    expect(result.json).toMatchObject({ error: { code: "no_pending_authorization" } });
    expect(world.requests).toHaveLength(0);
  });

  it("--wait refuses an expired pending file and deletes it", async () => {
    world.handler = flow([pending]);
    await world.run(["login", "--no-wait"]);
    world.clock = new Date("2026-06-15T12:11:00Z");
    const result = await world.run(["login", "--wait", "--json"]);
    expect(result.json).toMatchObject({ error: { code: "no_pending_authorization" } });
    await expect(stat(pendingFile())).rejects.toThrow();
  });

  it("--wait ignores a pending file of the other kind", async () => {
    await loginAs(world);
    world.handler = flow([pending], "step_up");
    await world.run(["reauth", "--no-wait"]);
    const result = await world.run(["login", "--wait", "--json"]);
    expect(result.json).toMatchObject({ error: { code: "no_pending_authorization" } });
  });

  it("refuses --no-wait together with --wait as a usage error", async () => {
    expect((await world.run(["login", "--no-wait", "--wait"])).code).toBe(2);
    expect((await world.run(["login", "--timeout", "0"])).code).toBe(2);
    expect((await world.run(["login", "--timeout", "abc"])).code).toBe(2);
  });

  it("revokes the replaced credential best-effort and keeps the new login when that fails", async () => {
    await loginAs(world, "enl_cli_OLDOLDOLDOLD0123456789");
    world.handler = (request) => {
      if (request.method === "DELETE") return { status: 500, body: errorBody("server_error") };
      return flow([{ status: 200, body: loginGrant }])(request);
    };
    const result = await world.run(["login", "--json"]);
    expect(result.code).toBe(0);
    const revoke = world.requests.find((r) => r.method === "DELETE");
    expect(revoke?.path).toBe("/v1/cli/credential");
    expect(revoke?.headers.authorization).toBe("Bearer enl_cli_OLDOLDOLDOLD0123456789");
    expect(JSON.parse(await readFile(credentialFile(), "utf8")).token).toBe(SENTINEL_CLI_TOKEN);
  });
});

describe("reauth", () => {
  beforeEach(async () => {
    await loginAs(world);
  });

  it("requires a stored credential", async () => {
    const anonymous = await makeWorld();
    anonymous.handler = flow([pending], "step_up");
    const result = await anonymous.run(["reauth", "--json"]);
    expect(result.json).toMatchObject({ error: { code: "not_logged_in" } });
    expect(anonymous.requests).toHaveLength(0);
  });

  it("authenticates the start with the CLI token and sends the business header", async () => {
    world.handler = flow(
      [{ status: 200, body: { kind: "step_up", reauthenticated_at: "2026-06-15T12:00:05Z" } }],
      "step_up"
    );
    const result = await world.run(["reauth", "--json"]);
    expect(result.json).toEqual({ reauthenticated_at: "2026-06-15T12:00:05Z" });
    const start = world.requests.find((r) => r.path === "/v1/cli/authorizations");
    expect(start?.body).toMatchObject({ kind: "step_up" });
    expect(start?.headers.authorization).toBe(`Bearer ${SENTINEL_CLI_TOKEN}`);
    expect(start?.headers["x-enlitt-business-id"]).toBe("biz_1");
    // A step-up never replaces the stored credential.
    expect(JSON.parse(await readFile(credentialFile(), "utf8")).credential_id).toBe("cred_1");
    noLeak(result, SENTINEL_CLI_TOKEN, SENTINEL_DEVICE_CODE);
  });

  it("--no-wait then --wait completes the step-up and deletes the pending file", async () => {
    world.handler = flow(
      [{ status: 200, body: { kind: "step_up", reauthenticated_at: "2026-06-15T12:00:05Z" } }],
      "step_up"
    );
    expect((await world.run(["reauth", "--no-wait"])).code).toBe(0);
    expect(JSON.parse(await readFile(pendingFile(), "utf8"))).toMatchObject({ kind: "step_up" });
    expect((await world.run(["reauth", "--wait"])).code).toBe(0);
    await expect(stat(pendingFile())).rejects.toThrow();
  });

  it("--wait also needs the stored credential", async () => {
    world.handler = flow([pending], "step_up");
    await world.run(["reauth", "--no-wait"]);
    await world.run(["logout"]);
    const result = await world.run(["reauth", "--wait", "--json"]);
    expect(result.json).toMatchObject({ error: { code: "not_logged_in" } });
  });
});
