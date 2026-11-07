/**
 * Roles and the local permission check (`specs/SDK-side routing.md` "Roles and
 * the local permission check"). Every role is a `BusinessAccess` fixture from
 * `ROLE_PERMISSIONS`; the CLI is only ever told the resolved permissions.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ENLITT_ERROR_CODE } from "@enlitt/protocol";
import type { BusinessPermission } from "@enlitt/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { COMMAND_PERMISSIONS } from "./commands.js";
import {
  accessBody,
  appDetail,
  errorBody,
  keyMetadata,
  loginAs,
  makeWorld,
  mutations,
  ROLE_PERMISSIONS,
  SENTINEL_SECRET,
  standardRoutes
} from "./test-harness.js";
import type { FixtureRole, Handler, World } from "./test-harness.js";

const ROLES = Object.keys(ROLE_PERMISSIONS) as FixtureRole[];
const ACCESS_PATH = "/v1/dashboard/business/access";

let world: World;

beforeEach(async () => {
  world = await makeWorld();
  await loginAs(world);
});

/** Standard reads plus the writes the permitted commands reach. */
function routes(extra: Handler = () => undefined): Handler {
  return standardRoutes((request) => {
    const given = extra(request);
    if (given !== undefined) return given;
    if (request.method === "POST" && request.path === "/v1/dashboard/business/keys")
      return {
        status: 201,
        body: { metadata: keyMetadata({ id: "key_new" }), secret: SENTINEL_SECRET }
      };
    if (request.method === "POST" && request.path === "/v1/dashboard/business/applications")
      return { status: 201, body: appDetail({ id: "app_7" }) };
    if (request.method === "PUT" && request.path.endsWith("/premium"))
      return { status: 200, body: appDetail() };
    return undefined;
  });
}

/** One invocation per `COMMAND_PERMISSIONS` entry, written so it passes usage checks. */
const INVOCATIONS: Readonly<Record<string, readonly string[]>> = {
  "business info": ["business", "info"],
  traffic: ["traffic"],
  "app list": ["app", "list"],
  "app show": ["app", "show", "app_1"],
  "key list": ["key", "list"],
  "app create": ["app", "create", "--name", "Web", "--environment", "test"],
  "app update": ["app", "update", "app_1", "--name", "Renamed"],
  "app premium": ["app", "premium", "app_1", "--on"],
  "key create": ["key", "create", "--app", "app_1", "--name", "k", "--write-env", ".env.local"],
  "key rotate": ["key", "rotate", "key_1", "--write-env", ".env.local"],
  "key revoke": ["key", "revoke", "key_1", "--confirm"],
  "key list --scope read-only": ["key", "list", "--scope", "read-only"],
  setup: ["setup", "--app", "app_1"]
};

const KEYS_REFUSAL = (role: string): string =>
  `Your role (${role}) in Acme Games can't create, rotate, revoke, or list read-only keys. Only the business owner can.`;
const KEYS_ACTION =
  "Ask the business owner to run this command, or to create the key in the dashboard Keys page.";
const APPS_REFUSAL = (role: string): string =>
  `Your role (${role}) in Acme Games can't create or change apps.`;
const APPS_ACTION =
  "Ask the business owner or an admin to make you a developer or admin, or to run this command.";
const PREMIUM_REFUSAL = (role: string): string =>
  `Your role (${role}) in Acme Games can't turn premium credit on or off.`;
const PREMIUM_ACTION =
  "Ask the business owner or an admin to run this command, or to change it on the app's dashboard page.";

function refusalFor(permission: BusinessPermission, role: string) {
  if (permission === "keys.manage") return { message: KEYS_REFUSAL(role), action: KEYS_ACTION };
  if (permission === "apps.manage") return { message: APPS_REFUSAL(role), action: APPS_ACTION };
  if (permission === "premium.manage")
    return { message: PREMIUM_REFUSAL(role), action: PREMIUM_ACTION };
  throw new Error(`no per-permission wording expected for ${permission}`);
}

describe("the local permission check", () => {
  it("covers every invocation in COMMAND_PERMISSIONS", () => {
    expect(Object.keys(INVOCATIONS).sort()).toEqual(Object.keys(COMMAND_PERMISSIONS).sort());
  });

  for (const role of ROLES) {
    for (const [command, needs] of Object.entries(COMMAND_PERMISSIONS)) {
      const held = ROLE_PERMISSIONS[role].includes(needs);
      it(`${role}: "${command}" ${held ? "passes the check" : `is refused (needs ${needs})`}`, async () => {
        world.access = accessBody(role);
        world.handler = routes();
        const result = await world.run([...INVOCATIONS[command]!, "--json"]);
        // The access read is always the first request.
        expect(world.requests[0]).toMatchObject({ method: "GET", path: ACCESS_PATH });
        if (held) {
          const error = (result.json as { error?: { code: string } }).error;
          expect(error?.code).not.toBe(ENLITT_ERROR_CODE.insufficient_permissions);
          return;
        }
        expect(result.code).toBe(1);
        expect(result.json).toMatchObject({
          error: { code: ENLITT_ERROR_CODE.insufficient_permissions, ...refusalFor(needs, role) }
        });
        // Nothing is half done: no request after the access read.
        expect(world.requests).toHaveLength(1);
      });
    }
  }

  it("setup that must create the application needs apps.manage, and a viewer can still reuse one", async () => {
    world.access = accessBody("viewer");
    world.handler = routes();
    const creating = await world.run(["setup", "--name", "Web", "--json"]);
    expect(creating.json).toMatchObject({
      error: { code: "insufficient_permissions", message: APPS_REFUSAL("viewer") }
    });
    expect(mutations(world)).toHaveLength(0);
    const reusing = await world.run(["setup", "--app", "app_1", "--json"]);
    expect(reusing.code).toBe(0);
  });

  it("usage errors and the secret-destination check come before the access read", async () => {
    world.access = accessBody("viewer");
    world.handler = routes();
    expect((await world.run(["key", "create", "--app", "app_1", "--name", "k"])).json).toBeUndefined();
    const noDestination = await world.run(["key", "create", "--app", "app_1", "--name", "k", "--json"]);
    expect(noDestination.json).toMatchObject({ error: { code: "secret_destination_required" } });
    const noConfirm = await world.run(["key", "revoke", "key_1", "--json"]);
    expect(noConfirm.json).toMatchObject({ error: { code: "confirmation_required" } });
    expect(world.requests).toHaveLength(0);
  });

  it("does not cache the role: a change applies on the next command", async () => {
    world.handler = routes();
    world.access = accessBody("owner");
    expect((await world.run(["app", "create", "--name", "A", "--environment", "test"])).code).toBe(0);
    world.access = accessBody("viewer");
    expect(
      (await world.run(["app", "create", "--name", "A", "--environment", "test", "--json"])).json
    ).toMatchObject({ error: { code: "insufficient_permissions" } });
    expect(world.requests.filter((request) => request.path === ACCESS_PATH)).toHaveLength(2);
  });

  it("a null active business is business_selection_required", async () => {
    world.access = { ...accessBody("owner"), active_business: null };
    world.handler = routes();
    const result = await world.run(["app", "list", "--json"]);
    expect(result.json).toMatchObject({ error: { code: "business_selection_required" } });
    expect(world.requests).toHaveLength(1);
  });

  it("the non-JSON form prints the message and the action on stderr", async () => {
    world.access = accessBody("developer");
    world.handler = routes();
    const result = await world.run(INVOCATIONS["key create"]!);
    expect(result.stderr).toBe(`error: ${KEYS_REFUSAL("developer")}\nnext: ${KEYS_ACTION}\n`);
  });
});

describe("a server insufficient_permissions", () => {
  it("renders the same message and action, and keeps the server code", async () => {
    // The login's role changed after the check: the access read said owner, the server says no.
    world.handler = routes((request) =>
      request.method === "POST" && request.path === "/v1/dashboard/business/keys"
        ? { status: 403, body: errorBody("insufficient_permissions", "Server wording.") }
        : undefined
    );
    const result = await world.run([...INVOCATIONS["key create"]!, "--json"]);
    expect(result.json).toMatchObject({
      error: {
        code: "insufficient_permissions",
        message: KEYS_REFUSAL("owner"),
        action: KEYS_ACTION
      }
    });
  });

  it("keeps the server's message for a permission with no wording of its own", async () => {
    world.access = accessBody("viewer");
    world.handler = routes((request) =>
      request.path === "/v1/dashboard/business"
        ? { status: 403, body: errorBody("insufficient_permissions", "Server wording.") }
        : undefined
    );
    const result = await world.run(["business", "info", "--json"]);
    expect(result.json).toMatchObject({
      error: { code: "insufficient_permissions", message: "Server wording." }
    });
  });
});

describe("whoami and status list the commands the role can run", () => {
  for (const role of ROLES) {
    it(`${role}: allowed_commands match COMMAND_PERMISSIONS`, async () => {
      world.access = accessBody(role);
      world.handler = routes();
      const expected = Object.entries(COMMAND_PERMISSIONS)
        .filter(([, needs]) => ROLE_PERMISSIONS[role].includes(needs))
        .map(([command]) => command);
      const whoami = await world.run(["whoami", "--json"]);
      expect(whoami.json).toMatchObject({ business: { role, allowed_commands: expected } });
      const status = await world.run(["status", "--json"]);
      expect(status.json).toMatchObject({ business: { allowed_commands: expected } });
    });
  }

  it("the human form says what the role can and cannot run", async () => {
    world.access = accessBody("developer");
    world.handler = routes();
    const { stdout } = await world.run(["whoami"]);
    expect(stdout).toContain("You can run: business info, traffic, app list, app show, key list, app create, app update, setup");
    expect(stdout).toContain("Not with your role: app premium, key create, key rotate, key revoke, key list --scope read-only");
    world.access = accessBody("owner");
    expect((await world.run(["whoami"])).stdout).not.toContain("Not with your role");
  });
});

describe("setup without keys.manage", () => {
  it("as a developer it creates and links the app, writes the client ID, mints no key, and reports the secret as missing", async () => {
    world.access = accessBody("developer");
    world.handler = routes();
    const result = await world.run(["setup", "--name", "Web", "--json"]);
    expect(result.code).toBe(0);
    expect(world.requests.some((request) => request.path.endsWith("/keys"))).toBe(false);
    expect(JSON.parse(await world.read("enlitt.json"))).toMatchObject({ applicationId: "app_7" });
    const env = await world.read(".env.local");
    expect(env).toContain("ENLITT_CLIENT_ID=");
    expect(env).not.toContain("ENLITT_SECRET_KEY");
    const document = result.json as { wrote: string[]; missing: { variable: string; action: string }[] };
    expect(document.wrote).toEqual(["ENLITT_CLIENT_ID"]);
    expect(document.missing).toEqual([
      {
        variable: "ENLITT_SECRET_KEY",
        action: `Only the business owner can create keys. Ask the owner to create an app key for Web (app_7) and put it in ENLITT_SECRET_KEY in .env.local.`
      }
    ]);
  });

  it("the human form prints the missing-key line before the next step", async () => {
    world.access = accessBody("admin");
    world.handler = routes();
    const { stdout } = await world.run(["setup", "--app", "app_1"]);
    const missing = stdout.indexOf("Only the business owner can create keys.");
    expect(missing).toBeGreaterThan(-1);
    expect(missing).toBeLessThan(stdout.indexOf("docs/authentication.md"));
  });

  it("as the owner it mints the key and `missing` is empty", async () => {
    world.access = accessBody("owner");
    world.handler = routes();
    const result = await world.run(["setup", "--name", "Web", "--json"]);
    expect(result.json).toMatchObject({
      wrote: ["ENLITT_CLIENT_ID", "ENLITT_SECRET_KEY"],
      missing: []
    });
  });

  it("a developer whose env file already holds the secret has nothing missing", async () => {
    world.access = accessBody("developer");
    world.handler = routes();
    await world.write(".env.local", `ENLITT_SECRET_KEY=${SENTINEL_SECRET}\n`);
    const result = await world.run(["setup", "--app", "app_1", "--json"]);
    expect(result.json).toMatchObject({ missing: [] });
  });
});

describe("no role name is compared", () => {
  it("no non-test source file under packages/cli/src names a role as a string literal", async () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const sources = (await readdir(directory)).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "test-harness.ts"
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = await readFile(join(directory, file), "utf8");
      expect(text, file).not.toMatch(/["'`](owner|admin|developer|viewer)["'`]/);
    }
  });
});
