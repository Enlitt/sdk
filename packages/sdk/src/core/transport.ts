/**
 * The module's single authenticated exit to Enlitt.
 *
 * `specs/SDK-side routing.md` gives this file three jobs that must live in
 * exactly one place: the definition of the internal client
 * (`InternalEnlittClient`, built once per factory call by
 * `createInternalClient()`), the one place a personal session is resolved
 * (`InternalEnlittClient.resolveSession`), and the one function that ever
 * issues an HTTP request to Enlitt (`requestEnlitt()`). Both the standard and
 * premium model files call through this file rather than `fetch` directly, so
 * every header, every safety check, and every retry the spec requires exists
 * exactly once instead of once per model.
 *
 * It owns exactly two internal retries and no others: the bounded, jittered
 * wait that absorbs `rate_limit_exceeded` (inside `requestEnlitt()` itself,
 * because it applies uniformly to every request this module sends), and a
 * bounded transient retry of a premium terminal report under one unchanged
 * `report_id`/`Idempotency-Key` (`reportEnlittPremiumTerminal()`, layered on
 * top of `requestEnlitt()` because it applies to exactly one call shape and
 * must never leak onto a preflight, a standard call, or a refusal). Every
 * other failure — every refusal, every conflict, every `4xx` other than `429
 * rate_limit_exceeded` — is normalized and thrown once, never retried here.
 *
 * It never accepts a personal identity as a caller-supplied parameter: the
 * only personal value that ever leaves this file is the opaque token
 * `client.resolveSession()` returns, and no argument, option, or request body
 * field can supply or override it. It never logs or returns that token,
 * prompt content, or a raw provider error, and it never runs in a browser —
 * it is reachable only through `@enlitt/sdk/server`, which the package export
 * map keeps out of the `browser` condition.
 */

import { ENLITT_API_VERSION, ENLITT_ERROR_CODE, ENLITT_VERSION_HEADER } from "@enlitt/protocol";
import {
  EnlittConfigurationError,
  EnlittError,
  normalizeEnlittModelError,
  type EnlittHttpErrorResponse,
  type EnlittMalformedResponse,
  type EnlittRequestCanceled,
  type EnlittTransportFailure
} from "./errors.js";
import { resolveBusinessAuthorizationHeader } from "../server/secrets.js";
import { getEnlittSession, type EnlittSession } from "./session.js";

/**
 * The SDK's own version, sent as `X-Enlitt-SDK-Version` so Enlitt's own logs
 * can tell which client behavior produced a given request without the header
 * carrying anything about the business or the user.
 *
 * A literal rather than a `package.json` import: this package ships as both
 * ESM and CJS, its `tsup` build does not embed the manifest, and a JSON
 * import here would tie a request-time value to a file layout assumption
 * this module has no other reason to make. It must be bumped by hand
 * alongside `package.json`'s `version` field.
 */
export const SDK_VERSION = "0.1.0";

/** Hosts `http:` is still accepted for, matching a developer's own machine. */
const LOCAL_HTTP_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The deployed default floor for a rate-limit wait when the refusal carries
 * no `Retry-After`. One second: long enough that an immediate retry cannot
 * reassemble the burst that caused the refusal, short enough that a business
 * under its own `maxRetries` does not perceive a hang.
 */
const DEFAULT_RATE_LIMIT_FLOOR_MS = 1_000;

/**
 * The deployed default bound on rate-limit retry attempts. Chosen so a caller
 * that never configures `rateLimit` still backs off a handful of times
 * before the failure surfaces, rather than waiting on `maxTotalWaitMs` alone
 * to end an unbounded attempt count.
 */
const DEFAULT_RATE_LIMIT_MAX_ATTEMPTS = 3;

/**
 * The deployed default wall-clock budget for a rate-limit wait, measured
 * from the first refusal. Kept comfortably under common serverless request
 * timeouts (typically 10-60s) so an exhausted budget surfaces as a typed
 * `EnlittRateLimitError` rather than the platform killing the process
 * mid-wait.
 */
const DEFAULT_RATE_LIMIT_MAX_TOTAL_WAIT_MS = 30_000;

/**
 * The deployed bound on how many times `reportEnlittPremiumTerminal()` will
 * resend one terminal report before giving up and handing the failure to
 * `onTerminalReportError`. Small and fixed, unlike the rate-limit wait: a
 * terminal report that keeps failing after a few attempts is failing for a
 * reason a delay will not fix, and the credit hold it would otherwise
 * release already has its own deadline-driven backstop on Enlitt's side.
 */
const TERMINAL_REPORT_MAX_ATTEMPTS = 3;

/** The floor of the delay between terminal-report retry attempts. */
const TERMINAL_REPORT_RETRY_DELAY_MS = 500;

/**
 * The largest total byte size this module will read out of a response's
 * headers before giving up on it as malformed. Bounding it is what keeps a
 * misbehaving or compromised endpoint from making this module buffer an
 * unbounded amount of attacker-controlled data before normalization ever
 * runs.
 */
const MAX_RESPONSE_HEADER_BYTES = 32 * 1024;

/** The largest response body this module will buffer before parsing it. */
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;

/**
 * Caller-supplied tuning for the rate-limit wait. Every field is optional
 * because `createInternalClient()` folds it over the SDK's own defaults
 * exactly once, at construction, which is what lets every later read of
 * `client.rateLimit` assume every field but `onRateLimit` is present.
 */
export interface EnlittRateLimitRetryOptions {
  /** Upper bound on attempts, including the first (minimum 1). Default {@link DEFAULT_RATE_LIMIT_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number;
  /** Upper bound on total time spent waiting, measured from the first refusal. Default {@link DEFAULT_RATE_LIMIT_MAX_TOTAL_WAIT_MS}. */
  readonly maxTotalWaitMs?: number;
  /**
   * Invoked once per wait, with the attempt number (1-based) about to be
   * slept and the jittered delay in milliseconds. The only way a business
   * observes a rate-limit wait without this module disclosing a plan fact.
   */
  readonly onRateLimit?: (attempt: number, delayMs: number) => void;
}

/**
 * Constructor options for `createInternalClient()`.
 *
 * `secretKey` and `baseUrl` are exactly what `resolveBusinessAuthorizationHeader()`
 * and the HTTPS assertion need and nothing more; neither this type nor the
 * client it builds ever carries a personal identity, because the only
 * personal value the transport ever sends is the token `resolveSession()`
 * (built from `session`, or from the ambient context) produces at request
 * time.
 */
export interface EnlittOptions {
  /** Forwarded to `resolveBusinessAuthorizationHeader()` unchanged. */
  readonly secretKey?: string;
  /**
   * Enlitt's base URL. Resolves from this option, then `ENLITT_BASE_URL`, then
   * the deployed Enlitt origin compiled into the package. Must be `https:`, or
   * `http:` on a local host. Parsed and validated once, at construction.
   */
  readonly baseUrl?: string;
  /**
   * An explicit session, for a caller that cannot rely on the ambient
   * `AsyncLocalStorage` context — a background job, or a framework
   * `enlittSessionMiddleware()` cannot wrap. When absent, every call resolves
   * the session from `getEnlittSession()` instead.
   */
  readonly session?: EnlittSession;
  readonly rateLimit?: EnlittRateLimitRetryOptions;
  /**
   * Observes a failure `reportEnlittPremiumTerminal()` could not recover
   * from after exhausting its bounded retry. There is no caller left to
   * return the error to by the time this fires — the provider call this
   * report describes has already completed — so this hook is the only way a
   * business ever learns a terminal report did not land.
   */
  readonly onTerminalReportError?: (error: EnlittError) => void;
}

/**
 * The internal client every request in this module is built from.
 *
 * Constructed once per factory call from the business's resolved secret and
 * the deployed environment, and never held as nullable: holding a client at
 * all is what makes a call managed, so there is no code path in this package
 * that represents "no Enlitt configuration" as a null or optional client
 * instead of failing at construction.
 */
export interface InternalEnlittClient {
  readonly baseUrl: string;
  /** The full `Authorization` header value, e.g. `Bearer sk_...`. Never logged or returned. */
  readonly businessAuthorization: string;
  readonly sdkVersion: string;
  /**
   * The module's single session resolution. Returns the explicit
   * `EnlittOptions.session` when one was given; otherwise defers to
   * `getEnlittSession()`, which itself distinguishes "no middleware
   * installed" (`EnlittConfigurationError`) from "signed out" (`null`,
   * raised here as `EnlittLoginRequiredError` with `providerInvoked: false`).
   * Both model files call this indirectly through `requestEnlitt()` rather
   * than resolving a session themselves, which is what keeps the three
   * outcomes from drifting apart between the standard and premium paths.
   */
  readonly resolveSession: () => EnlittSession;
  readonly rateLimit: Required<Omit<EnlittRateLimitRetryOptions, "onRateLimit">> &
    Pick<EnlittRateLimitRetryOptions, "onRateLimit">;
  readonly onTerminalReportError?: (error: EnlittError) => void;
}

/**
 * Builds the internal client from a factory call's resolved options.
 *
 * Resolves the business authorization header eagerly (through
 * `resolveBusinessAuthorizationHeader()`, the only path to that secret) so a
 * missing or unusable key fails at construction, before any network call and
 * before a provider is ever at risk of running unaccounted. Folds
 * `rateLimit` over the SDK's defaults exactly once here, so no per-request
 * code has to treat any field but `onRateLimit` as possibly absent.
 */
export function createInternalClient(options: EnlittOptions): InternalEnlittClient {
  // First, before secret resolution, so a bundling mistake never reaches a key.
  assertServerRuntime();

  const baseUrl = resolveBaseUrl(options.baseUrl);
  const businessAuthorization = resolveBusinessAuthorizationHeader(
    options.secretKey !== undefined ? { secretKey: options.secretKey } : {}
  );

  const rateLimitOptions = options.rateLimit;
  const maxAttempts = rateLimitOptions?.maxAttempts ?? DEFAULT_RATE_LIMIT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new EnlittConfigurationError("rateLimit.maxAttempts must be an integer of at least 1.");
  }
  const rateLimit: InternalEnlittClient["rateLimit"] = {
    maxAttempts,
    maxTotalWaitMs: rateLimitOptions?.maxTotalWaitMs ?? DEFAULT_RATE_LIMIT_MAX_TOTAL_WAIT_MS,
    ...(rateLimitOptions?.onRateLimit !== undefined ? { onRateLimit: rateLimitOptions.onRateLimit } : {})
  };

  const explicitSession = options.session;

  return {
    baseUrl,
    businessAuthorization,
    sdkVersion: SDK_VERSION,
    resolveSession: (): EnlittSession => {
      if (explicitSession !== undefined) {
        return explicitSession;
      }
      const session = getEnlittSession();
      if (session === null) {
        throw normalizeEnlittModelError(
          {
            kind: "http_error",
            status: 401,
            body: loginRequiredBody(),
            headers: {}
          },
          false
        );
      }
      return session;
    },
    rateLimit,
    ...(options.onTerminalReportError !== undefined
      ? { onTerminalReportError: options.onTerminalReportError }
      : {})
  };
}

/**
 * The deployed Enlitt origin compiled into the package, used when neither
 * `EnlittOptions.baseUrl` nor `ENLITT_BASE_URL` names one. Matches the default
 * `enlittOrigin` `server/callback.ts` falls back to; the two are the same
 * deployed origin and must not drift apart.
 */
const DEFAULT_ENLITT_ORIGIN = "https://api.enlitt.com";

/** The environment variable a business may set instead of passing `baseUrl` explicitly. */
const BASE_URL_ENV_KEY = "ENLITT_BASE_URL";

/**
 * Browser execution fails with `EnlittConfigurationError`. The check is
 * `typeof window !== "undefined" && typeof document !== "undefined"`,
 * matching `server/secrets.ts`'s own heuristic exactly.
 */
function assertServerRuntime(): void {
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    throw new EnlittConfigurationError(
      "enlitt() was called in a browser environment. It is server-only; ship @enlitt/sdk/browser to consumers instead."
    );
  }
}

/**
 * Resolves `baseUrl` from the option, then `ENLITT_BASE_URL`, then the
 * deployed default, and validates the result once through the identical HTTPS
 * rule `requestEnlitt()` applies per request (`assertHttps()`). A malformed
 * URL is folded into the same `EnlittConfigurationError` rather than leaking a
 * raw `TypeError`.
 */
function resolveBaseUrl(optionBaseUrl: string | undefined): string {
  const candidate = optionBaseUrl ?? readBaseUrlFromEnv() ?? DEFAULT_ENLITT_ORIGIN;
  try {
    assertHttps(candidate);
  } catch (thrown) {
    if (thrown instanceof EnlittConfigurationError) {
      throw thrown;
    }
    throw new EnlittConfigurationError(`Enlitt base URL is not a valid URL: ${String(candidate)}.`);
  }
  return candidate;
}

/** Mirrors `server/secrets.ts`'s guarded read of a `process.env` fallback, which no Workers-style runtime provides. */
function readBaseUrlFromEnv(): string | undefined {
  const runtime = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return runtime.process?.env?.[BASE_URL_ENV_KEY];
}

/**
 * Synthesizes the one error body `resolveSession()` needs to raise
 * `EnlittLoginRequiredError` through `normalizeEnlittModelError()` rather
 * than constructing a second error path that could disagree with the one
 * every HTTP refusal already goes through.
 */
function loginRequiredBody(): unknown {
  return {
    error: {
      message: "No Enlitt session is available for this request. Send the user through Enlitt login.",
      type: "authentication_error",
      param: null,
      code: ENLITT_ERROR_CODE.personal_login_required
    }
  };
}

/** One request this module knows how to issue. */
export interface EnlittRequestInit {
  readonly path: string;
  /** `POST` unless a read endpoint (`GET /v1/enlitt/usage`) says otherwise. */
  readonly method?: "POST" | "GET";
  /** Ignored for `GET`, which has no body. */
  readonly body?: unknown;
  /**
   * Sent as `Idempotency-Key` (and, for a terminal report, equals the body's
   * own `report_id`). Required for `POST`; a `GET` sends no `Idempotency-Key`,
   * because `PROTOCOLS.md` forbids one on a route that does not deduplicate.
   */
  readonly callId?: string;
  readonly accept: "application/json" | "text/event-stream";
  readonly signal?: AbortSignal;
}

/**
 * Issues one `POST` to `client.baseUrl + init.path` carrying every header the
 * protocol requires and no other identity-bearing header, and returns the
 * successful `Response` unread so a caller that needs a stream can consume
 * it incrementally.
 *
 * This is the only function in the package that calls `fetch()` against
 * Enlitt. Every safety property the spec requires — HTTPS, no redirects,
 * bounded response size, normalization of every failure, and the
 * `rate_limit_exceeded` wait — lives here so no call site can accidentally
 * skip one.
 */
export async function requestEnlitt(client: InternalEnlittClient, init: EnlittRequestInit): Promise<Response> {
  assertHttps(client.baseUrl);

  const url = new URL(init.path, client.baseUrl).toString();
  const session = client.resolveSession();

  // The exhaustive header set. `Enlitt-Version` names the API version this
  // build was written against; it is information for the server only, and the
  // SDK never reads a version header back (forward compatibility comes from
  // tolerant parsing, not negotiation).
  const headers: Record<string, string> = {
    Authorization: client.businessAuthorization,
    "X-Enlitt-User-Authorization": `Bearer ${session.token}`,
    Accept: init.accept,
    "X-Request-Id": generateRequestId(),
    [ENLITT_VERSION_HEADER]: ENLITT_API_VERSION,
    "X-Enlitt-SDK-Version": client.sdkVersion
  };
  if (init.method !== "GET") {
    if (init.callId === undefined) {
      throw new EnlittConfigurationError("An Enlitt POST request requires a call ID for its Idempotency-Key.");
    }
    headers["Idempotency-Key"] = init.callId;
    headers["Content-Type"] = "application/json";
  }

  const waitStartedAtMs = Date.now();

  for (let attempt = 1; ; attempt++) {
    const response = await sendOnce(url, headers, init);

    if (response.ok) {
      assertBoundedResponse(response);
      return response;
    }

    const error = await normalizeResponse(response);

    if (error.code !== ENLITT_ERROR_CODE.rate_limit_exceeded) {
      throw error;
    }

    const canRetry =
      attempt < client.rateLimit.maxAttempts &&
      Date.now() - waitStartedAtMs < client.rateLimit.maxTotalWaitMs;
    if (!canRetry) {
      throw error;
    }

    const floorMs = error.retryAfterMs ?? DEFAULT_RATE_LIMIT_FLOOR_MS;
    const delayMs = floorMs + Math.random() * (floorMs / 2);
    client.rateLimit.onRateLimit?.(attempt, delayMs);
    await sleep(delayMs, init.signal);
  }
}

/**
 * Retries a premium terminal report a bounded number of times on a
 * transient failure, resending the identical `init` — the same body (and so
 * the same `report_id`) and the same `Idempotency-Key` — on every attempt,
 * which is what makes the retry safe: Enlitt's own idempotency on that key
 * turns a duplicate send into a replay rather than a second report.
 *
 * Only a failure with no distinct business action of its own is treated as
 * transient: a transport failure that never produced a response, or one of
 * the three retryable server-side wire codes (`server_error`,
 * `provider_error`, `no_capable_route`). A refusal, a conflict, or an
 * exhausted `rate_limit_exceeded` wait (already retried once, inside
 * `requestEnlitt()`) is never retried again here — retrying a refusal a
 * second time under a different name is exactly what the spec forbids.
 *
 * Exhausting the bound reports the last error to `client.onTerminalReportError`
 * and rethrows it, rather than swallowing it: the hook exists because the
 * provider call this report describes has already finished and there is no
 * result left to withhold from a caller, not because the failure stops
 * mattering.
 */
export async function reportEnlittPremiumTerminal(
  client: InternalEnlittClient,
  init: EnlittRequestInit
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestEnlitt(client, init);
    } catch (thrown) {
      const error = thrown instanceof EnlittError ? thrown : normalizeEnlittModelError(thrown, false);
      const canRetry = isTransientTerminalReportFailure(error) && attempt < TERMINAL_REPORT_MAX_ATTEMPTS;
      if (!canRetry) {
        client.onTerminalReportError?.(error);
        throw error;
      }
      await sleep(TERMINAL_REPORT_RETRY_DELAY_MS, init.signal);
    }
  }
}

/**
 * Transient means "a delay may fix it": a transport failure that never
 * produced a response, or a retryable 5xx (`server_error`, `provider_error`,
 * or a newer 5xx code the classifier marked retryable). Anything else,
 * including an exhausted rate-limit wait, is not retried again here.
 */
function isTransientTerminalReportFailure(error: EnlittError): boolean {
  if (error.code === "transport_failed") {
    return true;
  }
  return error.retryable && error.code !== ENLITT_ERROR_CODE.rate_limit_exceeded;
}

/**
 * Sends exactly one HTTP request and normalizes a network-level failure into
 * the shapes `normalizeEnlittModelError()` recognizes, so `requestEnlitt()`
 * has only one kind of thing to handle beyond a `Response`: a thrown
 * `EnlittError`.
 *
 * Redirects are never followed: no legitimate Enlitt endpoint redirects,
 * and following one would either resend a bearer credential for two
 * principals to another origin or silently retarget a financial request.
 * `redirect: "manual"` hands the redirect back unfollowed and
 * `isRedirectResponse()` turns it into `transport_failed`. (`redirect:
 * "error"` would be the natural choice, but the Cloudflare Workers runtime
 * rejects it with a `TypeError` before sending, so every call from a Worker
 * failed.)
 */
async function sendOnce(url: string, headers: Record<string, string>, init: EnlittRequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "POST",
      headers,
      ...(init.method === "GET" ? {} : { body: JSON.stringify(init.body) }),
      redirect: "manual",
      ...(init.signal !== undefined ? { signal: init.signal } : {})
    });
  } catch (thrown) {
    const message = describeThrown(thrown);
    if (init.signal?.aborted === true) {
      throw normalizeEnlittModelError(
        { kind: "request_canceled", ...(message !== undefined ? { message } : {}) } satisfies EnlittRequestCanceled,
        false
      );
    }
    throw normalizeEnlittModelError(
      { kind: "transport_failed", ...(message !== undefined ? { message } : {}) } satisfies EnlittTransportFailure,
      false
    );
  }
  if (isRedirectResponse(response)) throw redirectRefused(response);
  return response;
}

/** The one message for a refused redirect (`specs/SDK-side routing.md`). */
const REDIRECT_REFUSED_MESSAGE = "Enlitt answered with a redirect, which the SDK never follows.";

/**
 * True for an unfollowed redirect under `redirect: "manual"`: a `3xx` status
 * (server runtimes such as Workers and Node) or an `opaqueredirect` response
 * with status `0` (browsers, which hide the redirect's details).
 */
export function isRedirectResponse(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

/**
 * The `transport_failed` error for a refused redirect. The body is cancelled
 * unread so the connection is released; nothing from it is used.
 */
export function redirectRefused(response: Response): EnlittError {
  void response.body?.cancel().catch(() => undefined);
  return normalizeEnlittModelError(
    { kind: "transport_failed", message: REDIRECT_REFUSED_MESSAGE } satisfies EnlittTransportFailure,
    false
  );
}

/**
 * Bounds response header and body size, then parses the OpenAI-shaped error
 * body and hands it to `normalizeEnlittModelError()`. A response this
 * function cannot safely read or parse normalizes to `malformed_response`
 * rather than exposing raw bytes or a parser exception to a caller.
 */
async function normalizeResponse(response: Response): Promise<EnlittError> {
  if (!isBoundedHeaderSet(response.headers)) {
    return normalizeEnlittModelError(
      { kind: "malformed_response", message: "Response headers exceeded the bounded size." } satisfies EnlittMalformedResponse,
      false
    );
  }

  const text = await readBoundedBody(response);
  if (text === undefined) {
    return normalizeEnlittModelError(
      { kind: "malformed_response", message: "Response body exceeded the bounded size." } satisfies EnlittMalformedResponse,
      false
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return normalizeEnlittModelError(
      { kind: "malformed_response", message: "Response body was not valid JSON." } satisfies EnlittMalformedResponse,
      false
    );
  }

  // The body is handed to the normalizer as-is: the protocol's classifier
  // decides whether it is an Enlitt error envelope, so no second structural
  // check lives here.
  return normalizeEnlittModelError(
    {
      kind: "http_error",
      status: response.status,
      body,
      headers: {
        "retry-after": response.headers.get("retry-after") ?? undefined,
        "x-request-id": response.headers.get("x-request-id") ?? undefined
      }
    } satisfies EnlittHttpErrorResponse,
    false
  );
}

/**
 * Enforces `MAX_RESPONSE_HEADER_BYTES` over a response's own header set,
 * summing each name and value once. Cheap and approximate on purpose: this
 * exists to stop a misbehaving endpoint from making this module hold an
 * unbounded amount of attacker-controlled header data, not to bill bytes
 * exactly.
 */
function isBoundedHeaderSet(headers: Headers): boolean {
  let total = 0;
  for (const [name, value] of headers.entries()) {
    total += name.length + value.length;
    if (total > MAX_RESPONSE_HEADER_BYTES) {
      return false;
    }
  }
  return true;
}

/**
 * Reads a response body up to `MAX_RESPONSE_BODY_BYTES`, returning
 * `undefined` rather than a truncated string when the bound is exceeded —
 * truncating and parsing a partial body risks succeeding on a document that
 * is not the one Enlitt actually sent.
 */
async function readBoundedBody(response: Response): Promise<string | undefined> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BODY_BYTES) {
    return undefined;
  }

  const body = response.body;
  if (body === null) {
    return "";
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(concatChunks(chunks, total));
}

/**
 * Reads a successful response's body as JSON, bounded by the same body-size
 * limit every other read in this file uses. An oversized body or one that is
 * not valid JSON is a `malformed_response` `EnlittError`, never a raw parser
 * exception. Every JSON-bodied Enlitt response (begin, terminal report, usage,
 * non-streaming standard response) is read through here, so no caller buffers
 * an unbounded body or parses JSON on its own.
 */
export async function readEnlittJson(response: Response): Promise<unknown> {
  const text = await readBoundedBody(response);
  if (text === undefined) {
    throw normalizeEnlittModelError(
      { kind: "malformed_response", message: "Response body exceeded the bounded size." } satisfies EnlittMalformedResponse,
      false
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw normalizeEnlittModelError(
      { kind: "malformed_response", message: "Response body was not valid JSON." } satisfies EnlittMalformedResponse,
      false
    );
  }
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * A successful response is bounded the same way a failing one is — checked
 * eagerly here so an oversized `200` fails fast rather than letting a caller
 * downstream (the standard or premium model) buffer it first.
 */
function assertBoundedResponse(response: Response): void {
  if (!isBoundedHeaderSet(response.headers)) {
    throw normalizeEnlittModelError(
      { kind: "malformed_response", message: "Response headers exceeded the bounded size." } satisfies EnlittMalformedResponse,
      false
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BODY_BYTES) {
    throw normalizeEnlittModelError(
      { kind: "malformed_response", message: "Response body exceeded the bounded size." } satisfies EnlittMalformedResponse,
      false
    );
  }
}

/**
 * HTTPS is required outside local development. `http:` is accepted only for
 * the three hosts a developer's own machine can present as, and there is no
 * environment flag that relaxes this — a business misconfiguring its own
 * deployed base URL must fail loudly rather than send its business and
 * personal credentials in the clear.
 *
 * Exported (in addition to being used per-request by `requestEnlitt()`) so
 * `language-model.ts` can run the identical check once, at `enlitt()`
 * construction, against the resolved `baseUrl` before any request is made —
 * the spec requires base URL validation to happen at construction, not per
 * call, and duplicating this rule there would let the two copies drift.
 */
export function assertHttps(baseUrl: string): void {
  const parsed = new URL(baseUrl);
  if (parsed.protocol === "https:") {
    return;
  }
  if (parsed.protocol === "http:" && LOCAL_HTTP_HOSTS.has(parsed.hostname)) {
    return;
  }
  throw new EnlittConfigurationError(
    `Enlitt base URL must use https: outside local development (got ${parsed.protocol} for host ` +
      `${parsed.hostname}). There is no environment flag that relaxes this.`
  );
}

/** A bounded, non-authoritative caller trace ID. `crypto.randomUUID()` is 36 characters, well under any reasonable bound. */
function generateRequestId(): string {
  return crypto.randomUUID();
}

/** Extracts a safe, bounded description from a caught value without ever including request content. */
function describeThrown(thrown: unknown): string | undefined {
  if (thrown instanceof Error) {
    return thrown.message.slice(0, 500);
  }
  return undefined;
}

/**
 * Sleeps for `delayMs`, or rejects immediately with the signal's abort
 * reason if `signal` is aborted before the sleep completes. Used by both
 * internal retries, so a caller-initiated cancellation ends a rate-limit
 * wait or a terminal-report retry exactly as promptly as it ends an
 * in-flight request.
 */
function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    // The caller's abort reason must escape unchanged, not wrapped in an
    // Error this module invents, so a caller can compare it against the
    // exact value it passed to `AbortController.abort()`.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(signal.reason as unknown);
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    function onAbort(): void {
      clearTimeout(timer);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above.
      reject(signal?.reason as unknown);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
