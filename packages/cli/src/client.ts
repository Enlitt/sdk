/**
 * The CLI's one HTTP exit to the Enlitt API.
 *
 * It exposes typed methods for exactly the routes `specs/PROTOCOLS.md` "CLI
 * authorization" admits to a CLI token, plus the two unauthenticated CLI
 * routes. Every body sent is checked by the protocol's strict request
 * validator and every body received by the matching validator in tolerant
 * mode. A `GET` is retried a little; a mutation never is, because a retried key
 * creation could mint two secrets. No body is ever logged.
 */
import { ENLITT_ERROR_CODE } from "@enlitt/protocol";
import {
  classifyEnlittErrorResponse,
  ENLITT_API_VERSION,
  ENLITT_VERSION_HEADER,
  validateApiKeyMetadataList,
  validateBusinessAccess,
  validateBusinessApplicationDetail,
  validateBusinessApplicationPremiumRequest,
  validateBusinessDashboardInfo,
  validateBusinessKeyListQuery,
  validateCliTokenGrant,
  validateCliTokenRequest,
  validateCreateBusinessApplicationRequest,
  validateCreateBusinessKeyRequest,
  validateCreateBusinessKeyResponse,
  validateStartCliAuthorizationRequest,
  validateStartedCliAuthorization,
  validateUpdateBusinessApplicationRequest
} from "@enlitt/protocol";
import type {
  ApiKeyMetadata,
  BusinessAccess,
  BusinessApplicationDetail,
  BusinessApplicationPremiumRequest,
  BusinessDashboardInfo,
  CliTokenGrant,
  CreateBusinessApplicationRequest,
  CreateBusinessKeyRequest,
  CreateBusinessKeyResponse,
  ResponseValidationResult,
  StartCliAuthorizationRequest,
  StartedCliAuthorization,
  UpdateBusinessApplicationRequest
} from "@enlitt/protocol";

import type { StoredCredential } from "./credentials.js";
import type { CliContext } from "./main.js";
import { CliError } from "./output.js";
import { CLI_VERSION } from "./version.js";

/** A server refusal, or a transport or parsing failure, with the request ID when known. */
export class EnlittDashboardError extends CliError {
  override readonly name = "EnlittDashboardError";
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(code: string, message: string, status: number, requestId?: string) {
    super(code, message);
    this.status = status;
    this.requestId = requestId;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Delays before the first and second retry of a `GET`. */
const GET_RETRY_DELAYS_MS = [500, 1_500] as const;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestSpec<T> {
  readonly method: Method;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  /** Whether the CLI token is sent. Only the two unauthenticated CLI routes say no. */
  readonly authenticated: boolean;
  /** Null for a `204`; otherwise validates the parsed body in tolerant mode. */
  readonly parse: ((body: unknown) => ResponseValidationResult<T>) | null;
}

/** Date-range and paging query shared by the business reads. */
export interface ReadQuery {
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface DashboardClient {
  startAuthorization(request: StartCliAuthorizationRequest): Promise<StartedCliAuthorization>;
  pollToken(deviceCode: string): Promise<CliTokenGrant>;
  revokeCredential(): Promise<void>;
  access(): Promise<BusinessAccess>;
  business(query?: ReadQuery): Promise<BusinessDashboardInfo>;
  application(id: string, query?: ReadQuery): Promise<BusinessApplicationDetail>;
  createApplication(request: CreateBusinessApplicationRequest): Promise<BusinessApplicationDetail>;
  updateApplication(id: string, request: UpdateBusinessApplicationRequest): Promise<BusinessApplicationDetail>;
  /** `PUT …/applications/{id}/premium`: turns the application's premium switch on or off. */
  setApplicationPremium(id: string, request: BusinessApplicationPremiumRequest): Promise<BusinessApplicationDetail>;
  listKeys(query: { scope?: "model" | "reporting"; application_id?: string }): Promise<readonly ApiKeyMetadata[]>;
  createKey(request: CreateBusinessKeyRequest): Promise<CreateBusinessKeyResponse>;
  rotateKey(keyId: string): Promise<CreateBusinessKeyResponse>;
  revokeKey(keyId: string): Promise<readonly ApiKeyMetadata[]>;
}

/** Throws a `usage_error`-class failure when a request body fails its strict validator. */
function checked<T>(result: ResponseValidationResult<T>): T {
  if (result.ok) return result.value;
  throw new CliError(ENLITT_ERROR_CODE.invalid_value, `${result.error.param}: ${result.error.message}`, {
    action: "Fix the flag or value named in the message and retry.",
    exitCode: 2
  });
}

function toQuery(query: ReadQuery | undefined): Record<string, string | undefined> {
  return {
    from: query?.from,
    to: query?.to,
    cursor: query?.cursor,
    limit: query?.limit === undefined ? undefined : String(query.limit)
  };
}

function requestIdOf(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "request_id" in body) {
    const id = (body).request_id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

/**
 * Builds the client. Pass the stored credential for any route that needs one;
 * the unauthenticated routes work with `null`. The token is registered with the
 * run's secret scrubber so it can never be printed.
 */
export function createDashboardClient(ctx: CliContext, credential: StoredCredential | null): DashboardClient {
  if (credential !== null) ctx.secrets.add(credential.token);

  async function attempt(spec: RequestSpec<unknown>): Promise<Response> {
    const url = new URL(spec.path, ctx.apiOrigin);
    for (const [name, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      [ENLITT_VERSION_HEADER]: ENLITT_API_VERSION,
      "User-Agent": `enlitt-cli/${CLI_VERSION}`
    };
    if (spec.authenticated && credential !== null) headers.Authorization = `Bearer ${credential.token}`;
    if (spec.method !== "GET" && credential !== null) headers["X-Enlitt-Business-Id"] = credential.business.id;
    let body: string | undefined;
    if (spec.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(spec.body);
    }
    return ctx.deps.fetch(url, {
      method: spec.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  }

  /** Sends the request, retrying only a `GET` on a network error or 502/503/504. */
  async function send(spec: RequestSpec<unknown>): Promise<Response> {
    const retries = spec.method === "GET" ? GET_RETRY_DELAYS_MS.length : 0;
    for (let tries = 0; ; tries += 1) {
      let response: Response | undefined;
      try {
        response = await attempt(spec);
      } catch {
        // The underlying error can echo a URL or header, so only its existence is kept.
        if (tries >= retries) {
          throw new EnlittDashboardError("network_error", "Could not reach the Enlitt API.", 0);
        }
      }
      if (response !== undefined && !(RETRYABLE_STATUSES.has(response.status) && tries < retries)) {
        return response;
      }
      await ctx.deps.sleep(GET_RETRY_DELAYS_MS[tries] ?? 0);
    }
  }

  async function request<T>(spec: RequestSpec<T>): Promise<T> {
    if (spec.authenticated && credential === null) {
      throw new CliError("not_logged_in", "You are not logged in to Enlitt.");
    }
    const response = await send(spec);
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new EnlittDashboardError("network_error", "The Enlitt API response was cut off.", response.status);
    }
    let parsed: unknown = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const classified = classifyEnlittErrorResponse(response.status, parsed);
      if (classified !== null) {
        throw new EnlittDashboardError(
          classified.code,
          classified.message ?? `The Enlitt API refused the request (${classified.code}).`,
          response.status,
          requestIdOf(parsed)
        );
      }
      throw new EnlittDashboardError(
        response.status >= 500 ? ENLITT_ERROR_CODE.server_error : "unexpected_response",
        `The Enlitt API answered ${response.status} without an error body.`,
        response.status
      );
    }
    if (spec.parse === null) return undefined as T;
    const result = spec.parse(parsed);
    if (!result.ok) {
      // Only the field path is reported; the body may hold a secret.
      throw new EnlittDashboardError(
        "invalid_response",
        `The Enlitt API answered with an unexpected shape (${result.error.param}).`,
        response.status
      );
    }
    return result.value;
  }

  const tolerant = { mode: "tolerant" } as const;

  /** Parses a key creation or rotation response and registers its secret for scrubbing. */
  function parseKeyResponse(body: unknown): ResponseValidationResult<CreateBusinessKeyResponse> {
    const result = validateCreateBusinessKeyResponse(body, tolerant);
    if (result.ok) ctx.secrets.add(result.value.secret);
    return result;
  }

  return {
    startAuthorization: async (input) => {
      const body = checked(validateStartCliAuthorizationRequest(input));
      return request({
        method: "POST",
        path: "/v1/cli/authorizations",
        body,
        authenticated: input.kind === "step_up",
        parse: (value) => {
          const result = validateStartedCliAuthorization(value, tolerant);
          if (result.ok) ctx.secrets.add(result.value.device_code);
          return result;
        }
      });
    },
    pollToken: async (deviceCode) => {
      ctx.secrets.add(deviceCode);
      return request({
        method: "POST",
        path: "/v1/cli/token",
        body: checked(validateCliTokenRequest({ device_code: deviceCode })),
        authenticated: false,
        parse: (value) => {
          const result = validateCliTokenGrant(value, tolerant);
          if (result.ok && result.value.kind === "login") ctx.secrets.add(result.value.token);
          return result;
        }
      });
    },
    revokeCredential: () =>
      request({ method: "DELETE", path: "/v1/cli/credential", authenticated: true, parse: null }),
    access: () =>
      request({
        method: "GET",
        path: "/v1/dashboard/business/access",
        authenticated: true,
        parse: (value) => validateBusinessAccess(value, tolerant)
      }),
    business: (query) =>
      request({
        method: "GET",
        path: "/v1/dashboard/business",
        query: toQuery(query),
        authenticated: true,
        parse: (value) => validateBusinessDashboardInfo(value, tolerant)
      }),
    application: (id, query) =>
      request({
        method: "GET",
        path: `/v1/dashboard/business/applications/${encodeURIComponent(id)}`,
        query: toQuery(query),
        authenticated: true,
        parse: (value) => validateBusinessApplicationDetail(value, tolerant)
      }),
    createApplication: async (input) =>
      request({
        method: "POST",
        path: "/v1/dashboard/business/applications",
        body: checked(validateCreateBusinessApplicationRequest(input)),
        authenticated: true,
        parse: (value) => validateBusinessApplicationDetail(value, tolerant)
      }),
    updateApplication: async (id, input) =>
      request({
        method: "PATCH",
        path: `/v1/dashboard/business/applications/${encodeURIComponent(id)}`,
        body: checked(validateUpdateBusinessApplicationRequest(input)),
        authenticated: true,
        parse: (value) => validateBusinessApplicationDetail(value, tolerant)
      }),
    setApplicationPremium: async (id, input) =>
      request({
        method: "PUT",
        path: `/v1/dashboard/business/applications/${encodeURIComponent(id)}/premium`,
        body: checked(validateBusinessApplicationPremiumRequest(input)),
        authenticated: true,
        parse: (value) => validateBusinessApplicationDetail(value, tolerant)
      }),
    listKeys: async (query) => {
      const valid = checked(validateBusinessKeyListQuery(query));
      return request({
        method: "GET",
        path: "/v1/dashboard/business/keys",
        query: { scope: valid.scope, application_id: valid.application_id },
        authenticated: true,
        parse: (value) => validateApiKeyMetadataList(value, tolerant)
      });
    },
    createKey: async (input) =>
      request({
        method: "POST",
        path: "/v1/dashboard/business/keys",
        body: checked(validateCreateBusinessKeyRequest(input)),
        authenticated: true,
        parse: parseKeyResponse
      }),
    rotateKey: (keyId) =>
      request({
        method: "POST",
        path: `/v1/dashboard/business/keys/${encodeURIComponent(keyId)}/rotate`,
        authenticated: true,
        parse: parseKeyResponse
      }),
    revokeKey: (keyId) =>
      request({
        method: "DELETE",
        path: `/v1/dashboard/business/keys/${encodeURIComponent(keyId)}`,
        authenticated: true,
        parse: (value) => validateApiKeyMetadataList(value, tolerant)
      })
  };
}
