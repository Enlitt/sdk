import { beforeEach, describe, expect, it } from "vitest";

import { createDashboardClient, EnlittDashboardError } from "./client.js";
import type { StoredCredential } from "./credentials.js";
import {
  accessBody,
  businessInfo,
  contextFor,
  errorBody,
  keyMetadata,
  makeWorld,
  SENTINEL_CLI_TOKEN,
  SENTINEL_DEVICE_CODE,
  SENTINEL_SECRET
} from "./test-harness.js";
import type { World } from "./test-harness.js";

let world: World;

beforeEach(async () => {
  world = await makeWorld();
});

const credential: StoredCredential = {
  version: 1,
  api_origin: "https://api.enlitt.com",
  token: SENTINEL_CLI_TOKEN,
  credential_id: "cred_1",
  business: { id: "biz_1", name: "Acme Games" },
  login_email: "dev@example.com",
  token_expires_at: "2027-01-01T00:00:00Z"
};

const clientFor = (signedIn = true) => createDashboardClient(contextFor(world), signedIn ? credential : null);

describe("request headers", () => {
  it("a GET sends Bearer, Enlitt-Version, and no business header", async () => {
    world.handler = () => ({ status: 200, body: accessBody() });
    await clientFor().access();
    const request = world.requests[0]!;
    expect(request.headers.authorization).toBe(`Bearer ${SENTINEL_CLI_TOKEN}`);
    expect(request.headers["enlitt-version"]).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(request.headers["x-enlitt-business-id"]).toBeUndefined();
    expect(request.headers["user-agent"]).toMatch(/^enlitt-cli\//);
  });

  it("every non-GET sends X-Enlitt-Business-Id", async () => {
    world.handler = (request) => {
      if (request.method === "DELETE" && request.path.includes("/keys/")) return { status: 200, body: [keyMetadata()] };
      if (request.method === "DELETE") return { status: 204 };
      if (request.path.endsWith("/rotate")) return { status: 200, body: { metadata: keyMetadata(), secret: SENTINEL_SECRET } };
      return { status: 201, body: { metadata: keyMetadata(), secret: SENTINEL_SECRET } };
    };
    const client = clientFor();
    await client.createKey({ scope: "model", application_id: "app_1", name: "n" } as never);
    await client.rotateKey("key_1");
    await client.revokeKey("key_1");
    await client.revokeCredential();
    expect(world.requests).toHaveLength(4);
    for (const request of world.requests) {
      expect(request.method).not.toBe("GET");
      expect(request.headers["x-enlitt-business-id"], request.path).toBe("biz_1");
      expect(request.headers.authorization, request.path).toBe(`Bearer ${SENTINEL_CLI_TOKEN}`);
    }
  });

  it("the two unauthenticated routes send no token and no business header", async () => {
    world.handler = (request) =>
      request.path === "/v1/cli/authorizations"
        ? {
            status: 201,
            body: {
              device_code: SENTINEL_DEVICE_CODE,
              user_code: "BCDF-GHJK",
              verification_uri: "https://enlitt.com/cli/authorize",
              verification_uri_complete: "https://enlitt.com/cli/authorize?code=BCDF-GHJK",
              expires_in: 600,
              interval: 5
            }
          }
        : { status: 400, body: errorBody("authorization_pending") };
    const client = clientFor(false);
    await client.startAuthorization({ kind: "login", device_label: "laptop" });
    await expect(client.pollToken(SENTINEL_DEVICE_CODE)).rejects.toMatchObject({ code: "authorization_pending", status: 400 });
    for (const request of world.requests) {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["x-enlitt-business-id"]).toBeUndefined();
    }
  });

  it("an authenticated call without a credential fails before any request", async () => {
    await expect(clientFor(false).access()).rejects.toMatchObject({ code: "not_logged_in" });
    expect(world.requests).toHaveLength(0);
  });

  it("refuses an invalid request body before sending", async () => {
    await expect(clientFor(false).startAuthorization({ kind: "login", device_label: "" })).rejects.toBeTruthy();
    expect(world.requests).toHaveLength(0);
  });
});

describe("retries", () => {
  it("retries a GET on 503 up to twice with backoff, then succeeds", async () => {
    let calls = 0;
    world.handler = () => {
      calls += 1;
      return calls < 3 ? { status: 503, body: errorBody("service_unavailable") } : { status: 200, body: accessBody() };
    };
    await clientFor().access();
    expect(calls).toBe(3);
    expect(world.sleeps).toEqual([500, 1500]);
  });

  it("gives up after two retries and reports the refusal", async () => {
    world.handler = () => ({ status: 503, body: errorBody("service_unavailable", "Try later.") });
    await expect(clientFor().access()).rejects.toMatchObject({ code: "service_unavailable", status: 503 });
    expect(world.requests).toHaveLength(3);
  });

  it("retries a GET after a network error and reports network_error without the cause", async () => {
    world.handler = () => {
      throw new Error(`socket hang up ${SENTINEL_CLI_TOKEN}`);
    };
    const error = await clientFor().access().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "network_error", status: 0 });
    expect(String((error as Error).message)).not.toContain(SENTINEL_CLI_TOKEN);
    expect(world.requests).toHaveLength(3);
  });

  it("never retries a mutation, even on 503 or a network error", async () => {
    world.handler = () => ({ status: 503, body: errorBody("service_unavailable") });
    await expect(clientFor().rotateKey("key_1")).rejects.toMatchObject({ status: 503 });
    expect(world.requests).toHaveLength(1);
    world.requests.length = 0;
    world.handler = () => {
      throw new Error("reset");
    };
    await expect(clientFor().revokeKey("key_1")).rejects.toMatchObject({ code: "network_error" });
    expect(world.requests).toHaveLength(1);
  });

  it("does not retry a plain 4xx", async () => {
    world.handler = () => ({ status: 404, body: errorBody("not_found") });
    await expect(clientFor().application("app_x")).rejects.toMatchObject({ status: 404 });
    expect(world.requests).toHaveLength(1);
  });
});

describe("responses", () => {
  it("maps the error envelope to code, message, status, and request id", async () => {
    world.handler = () => ({ status: 403, body: errorBody("insufficient_permissions", "Needs keys.manage.") });
    const error = (await clientFor().access().catch((e: unknown) => e)) as EnlittDashboardError;
    expect(error).toBeInstanceOf(EnlittDashboardError);
    expect(error).toMatchObject({ code: "insufficient_permissions", message: "Needs keys.manage.", status: 403, requestId: "req_test" });
  });

  it("falls back to a generic code for a body that is not an envelope", async () => {
    world.handler = () => ({ status: 500 });
    await expect(clientFor().access()).rejects.toMatchObject({ code: "server_error", status: 500 });
    world.handler = () => ({ status: 418 });
    await expect(clientFor().access()).rejects.toMatchObject({ code: "unexpected_response" });
  });

  it("parses tolerantly: an unknown enum value reads as other instead of failing", async () => {
    world.handler = () => ({
      status: 200,
      body: businessInfo({
        payout: {
          eligible: false,
          connected_account_status: "none",
          policy_code_version: "2026-09-29",
          minimum_available_nano_usd: "1",
          next_eligible_at: null,
          blocked_reason: "a_reason_from_the_future"
        }
      })
    });
    const info = await clientFor().business();
    expect(info.payout.blocked_reason).toBe("other");
  });

  it("reports invalid_response with only the field path, never the body", async () => {
    world.handler = () => ({ status: 200, body: { ...businessInfo(), earnings: SENTINEL_SECRET } });
    const error = (await clientFor().business().catch((e: unknown) => e)) as EnlittDashboardError;
    expect(error).toMatchObject({ code: "invalid_response" });
    expect(error.message).toContain("earnings");
    expect(error.message).not.toContain(SENTINEL_SECRET);
  });

  it("serialises read queries and skips undefined values", async () => {
    world.handler = () => ({ status: 200, body: businessInfo() });
    await clientFor().business({ from: "2026-06-01T00:00:00Z", to: "2026-06-02T00:00:00Z", cursor: "c1" });
    const query = world.requests[0]!.query;
    expect([query.get("from"), query.get("to"), query.get("cursor")]).toEqual(["2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z", "c1"]);
    world.requests.length = 0;
    await clientFor().business();
    expect([...world.requests[0]!.query.keys()]).toEqual([]);
  });

  it("a successful key response puts the secret in the scrubber", async () => {
    world.handler = () => ({ status: 201, body: { metadata: keyMetadata(), secret: SENTINEL_SECRET } });
    const ctx = contextFor(world);
    const result = await createDashboardClient(ctx, credential).createKey({ scope: "model", application_id: "app_1", name: "n" } as never);
    expect(result.secret).toBe(SENTINEL_SECRET);
    expect(ctx.secrets.scrub(`got ${SENTINEL_SECRET}`)).not.toContain(SENTINEL_SECRET);
  });
});
