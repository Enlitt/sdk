/**
 * The one premium billing lifecycle, with no framework dependency.
 *
 * `specs/SDK-side routing.md` gives this file the framework-agnostic core of
 * premium mode: a business runs a model call it pays for, and Enlitt only
 * accounts for it. The call is bracketed by a content-free begin (a maximum
 * charge in NANOUSD, declared before the provider runs) and exactly one
 * terminal report (a status and the actual NANOUSD charge, sent after it).
 *
 * `runPremiumCharge()` is the single implementation of that lifecycle: one
 * begin, one status rule, one charge rule, one report path. The public
 * `withPremiumCharge()` in this file and the Vercel adapter in
 * `vercel/premium-language-model.ts` are both thin layers over it, so moving a
 * call between the two changes how the charge is computed and nothing about how
 * it is settled.
 *
 * This file imports nothing from the Vercel AI SDK, and it never sends prompts,
 * messages, outputs, files, tools, provider options, provider keys, raw errors,
 * or content hashes to Enlitt: every body it builds is assembled field by field
 * from bounded named inputs, never by forwarding a caller-supplied object.
 *
 * Every NANOUSD amount is a canonical base-10 integer string and is compared
 * only as a `bigint`; none is ever converted to `number`, rounded, or displayed.
 */

import {
  CanonicalIntegerError,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IdempotencyKeyError,
  assertIdempotencyKey,
  parseCanonicalInteger,
  validateBeginPremiumOperationRequest,
  validateBeginPremiumOperationResponse,
  validateCallerMetadata,
  validateReportPremiumTerminalRequest,
  validateReportPremiumTerminalResponse
} from "@enlitt/protocol";
import { EnlittConfigurationError, EnlittError, normalizeEnlittModelError } from "./errors.js";
import {
  createInternalClient,
  readEnlittJson,
  reportEnlittPremiumTerminal,
  requestEnlitt,
  type EnlittOptions,
  type InternalEnlittClient
} from "./transport.js";

// --- Public types ----------------------------------------------------------

/**
 * Records the NANOUSD amount to report for the call. Callable any number of
 * times; the last call wins. Throws `EnlittConfigurationError` synchronously
 * for an amount that is not a canonical nonnegative integer string, and for a
 * call made after the report has been sent.
 */
export type PremiumChargeFunction = (amountNanoUsd: string) => void;

/**
 * The optional content-free facts a business may attach to the terminal
 * report. None is required and none has a financial effect.
 */
export interface PremiumTerminalFacts {
  readonly usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  readonly finishReason?: string;
  readonly providerResponseId?: string;
  readonly delivery?: { outputStarted: boolean; outputCompleted: boolean };
  readonly timing?: { startedAt: string; endedAt: string };
  readonly errorCategory?: "provider" | "timeout" | "network" | "invalid_request" | "canceled" | "unknown";
}

/** The admitted operation, as handed to a `withPremiumCharge()` callback. */
export interface PremiumChargeHandle {
  readonly operationId: string;
  /** The most the report can charge: the declared maximum, lowered by the server to this user's per-call limit. */
  readonly effectiveMaxChargeNanoUsd: string;
  readonly terminalDeadline: string;
  /** Records safe facts for the terminal report; the last call wins. */
  describe(facts: PremiumTerminalFacts): void;
}

/** What one premium operation declares at begin. */
export interface PremiumChargeRequest {
  readonly maxCharge: string;
  readonly provider: { id: string; model: string };
  readonly callId?: string;
  readonly reportingDeadlineMs?: number;
  readonly metadata?: Record<string, string>;
  readonly signal?: AbortSignal;
}

/**
 * The admitted operation as returned by Enlitt, carried opaquely to the
 * terminal report. The response's equal `reserved_nano_usd` is validated and
 * otherwise not exposed; no credit or pricing-version field exists on the wire.
 */
export interface PremiumOperation {
  readonly operationId: string;
  readonly effectiveMaxChargeNanoUsd: string;
  readonly terminalDeadline: string;
}

/** One terminal report in the TypeScript shape this module works in. */
export interface PremiumTerminalReport extends PremiumTerminalFacts {
  readonly reportId: string;
  readonly status: "completed" | "failed" | "canceled";
  readonly chargeNanoUsd: string;
}

/** Options for {@link withPremiumCharge}: the shared construction options plus one premium call's declaration. */
export interface WithPremiumChargeOptions extends EnlittOptions {
  /** NANOUSD, a canonical nonnegative integer string. */
  maxCharge: string;
  /** Bounded labels, as on the premium begin request. */
  provider: { id: string; model: string };
  /** The call ID; default a fresh random one. */
  idempotencyKey?: string;
  reportingDeadlineMs?: number;
  metadata?: Record<string, string>;
  signal?: AbortSignal;
}

// --- Shared option validation ----------------------------------------------
//
// `withPremiumCharge()` and the Vercel `readEnlittCallOptions()` apply the same
// rules, so the rules live here once. Every failure is an
// `EnlittConfigurationError` raised before any Enlitt or provider request.

/** Visible ASCII, matching the protocol's own `Idempotency-Key` character rule. */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * A supplied idempotency key is a base, not the call identity: the Vercel
 * adapter appends `.<prompt item count>`. The floor is the protocol's own
 * 16-character floor, imported rather than restated, so every derived ID
 * satisfies the wire bound by construction; the ceiling stays well under 255
 * so the appended suffix can never push a derived ID over it.
 */
export const IDEMPOTENCY_KEY_OPTION_MIN_LENGTH = IDEMPOTENCY_KEY_MIN_LENGTH;
export const IDEMPOTENCY_KEY_OPTION_MAX_LENGTH = 200;

/**
 * Validates a NANOUSD amount: a canonical nonnegative base-10 integer string
 * with no sign, fraction, exponent, whitespace, or noncanonical leading zero.
 * `"0"` is valid. Parsed as `bigint` (so values beyond the safe-integer range
 * keep full precision) and returned as the exact string the caller supplied.
 */
export function assertNanoUsd(value: unknown, label: string): string {
  try {
    parseCanonicalInteger(value, label);
  } catch (thrown) {
    if (thrown instanceof CanonicalIntegerError) {
      throw new EnlittConfigurationError(thrown.message);
    }
    throw thrown;
  }
  return value as string;
}

/** Validates a business-supplied idempotency key base (16-200 visible ASCII characters). */
export function assertIdempotencyKeyBase(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < IDEMPOTENCY_KEY_OPTION_MIN_LENGTH ||
    value.length > IDEMPOTENCY_KEY_OPTION_MAX_LENGTH ||
    !VISIBLE_ASCII.test(value)
  ) {
    throw new EnlittConfigurationError(
      `${label} must be ${IDEMPOTENCY_KEY_OPTION_MIN_LENGTH}-${IDEMPOTENCY_KEY_OPTION_MAX_LENGTH} visible ASCII characters.`
    );
  }
  return value;
}

/**
 * Validates a requested reporting deadline as a positive safe integer. The
 * deployed maximum is server policy and is not knowable locally, so no local
 * maximum is applied; the server bounds it and its returned deadline is
 * authoritative.
 */
export function assertReportingDeadlineMs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new EnlittConfigurationError(`${label} must be a positive safe integer.`);
  }
  return value;
}

/**
 * Validates caller metadata with the protocol's own `Record<string, string>`
 * rule (at most 16 entries, bounded keys and values, no `enlitt_` prefix): one
 * rule and one validator rather than a per-mode type.
 */
export function assertCallerMetadata(value: unknown, label: string): Record<string, string> {
  const validated = validateCallerMetadata(value, label);
  if (!validated.ok) {
    throw new EnlittConfigurationError(`${validated.error.message} (${validated.error.param})`);
  }
  return validated.value;
}

/** Validates a call ID against the protocol's 16-255 visible-ASCII `Idempotency-Key` bound. */
export function assertCallId(callId: string): string {
  try {
    return assertIdempotencyKey(callId);
  } catch (thrown) {
    if (thrown instanceof IdempotencyKeyError) {
      throw new EnlittConfigurationError(
        `The call ID "${callId}" is not a valid Idempotency-Key (must be ` +
          `${IDEMPOTENCY_KEY_MIN_LENGTH}-${IDEMPOTENCY_KEY_MAX_LENGTH} visible ASCII characters).`
      );
    }
    throw thrown;
  }
}

/** A freshly generated, unique-per-operation random value of at least 16 visible ASCII characters (a UUID is 36). */
export function generateRandomCallId(): string {
  return crypto.randomUUID();
}

// --- Wire paths ------------------------------------------------------------

/** The one relative path an operation is begun at, per `specs/PROTOCOLS.md` "Begin premium operation". */
const BEGIN_PREMIUM_OPERATION_PATH = "/v1/enlitt/operations";

/** The one relative path a terminal outcome is reported to, per "Report premium terminal state". */
function terminalReportPath(operationId: string): string {
  return `/v1/enlitt/operations/${encodeURIComponent(operationId)}/terminal`;
}

// --- Begin -----------------------------------------------------------------

/**
 * Calls **Begin premium operation** before the provider ever runs.
 *
 * Sends `mode: "premium"`, `max_charge_nano_usd` exactly as the business
 * declared it, `reporting_deadline_ms` when supplied, the bounded `provider`
 * labels, and `metadata`. The call ID travels as the request's
 * `Idempotency-Key`, never as a body field: the protocol lists no such field.
 * Enlitt performs the conversion to credit units; this function sends no credit
 * figure and reads no balance figure.
 *
 * The body is validated with the protocol's strict request validator before it
 * is sent (strict out). The response is parsed in tolerant mode (tolerant in):
 * an extra field or an unknown `billing` value still admits the operation. The
 * returned `effective_max_charge_nano_usd` and `terminal_deadline` are
 * authoritative regardless of what was requested.
 *
 * A refusal, a business authentication failure, or a transport failure
 * surfaces as the corresponding typed error with `providerInvoked: false`;
 * there is no path from a refusal to a provider invocation, including a
 * `rate_limit_exceeded` whose transport wait was exhausted (defensive: the
 * server never sends it on the premium path).
 */
export async function beginPremiumOperation(
  client: InternalEnlittClient,
  request: PremiumChargeRequest,
  callId: string
): Promise<PremiumOperation> {
  const body: Record<string, unknown> = {
    mode: "premium",
    max_charge_nano_usd: request.maxCharge,
    provider: { id: request.provider.id, model: request.provider.model }
  };
  if (request.reportingDeadlineMs !== undefined) {
    body.reporting_deadline_ms = request.reportingDeadlineMs;
  }
  if (request.metadata !== undefined) {
    body.metadata = request.metadata;
  }

  const validated = validateBeginPremiumOperationRequest(body);
  if (!validated.ok) {
    throw new EnlittConfigurationError(
      `The premium operation request is invalid: ${validated.error.message} (${validated.error.param}).`
    );
  }

  const response = await requestEnlitt(client, {
    path: BEGIN_PREMIUM_OPERATION_PATH,
    body: validated.value,
    callId,
    accept: "application/json",
    ...(request.signal !== undefined ? { signal: request.signal } : {})
  });

  const parsed = validateBeginPremiumOperationResponse(await readEnlittJson(response), { mode: "tolerant" });
  if (!parsed.ok) {
    throw new EnlittError(
      "malformed_response",
      `Enlitt's premium operation response could not be validated: ${parsed.error.message} (${parsed.error.param}).`
    );
  }

  return {
    operationId: parsed.value.operation_id,
    effectiveMaxChargeNanoUsd: parsed.value.effective_max_charge_nano_usd,
    terminalDeadline: parsed.value.terminal_deadline
  };
}

// --- Terminal report -------------------------------------------------------

/**
 * Sends one idempotent content-free terminal report to **Report premium
 * terminal state**, through the transport's bounded transient retry, which
 * resends the identical body and `Idempotency-Key` so a retry is a replay and
 * never a second report. `report.reportId` is generated once per operation.
 *
 * Never propagates a delivery failure into its caller. When the transport's
 * retries are exhausted, or Enlitt answers `409`, the typed error has already
 * been handed to `client.onTerminalReportError` (by the transport) and is
 * dropped here: a delivered provider output is a fact the business already
 * paid for, and turning an unrelated reporting failure into a thrown error
 * would make it discard output it already has. An undelivered report instead
 * lets the operation expire at its deadline, charging nothing.
 *
 * The response is parsed tolerantly. A report whose `status` reads as `"other"`
 * is still a delivered report: it is neither retried nor passed to
 * `onTerminalReportError`.
 */
export async function reportPremiumTerminalState(
  client: InternalEnlittClient,
  operation: PremiumOperation,
  report: PremiumTerminalReport
): Promise<void> {
  const body: Record<string, unknown> = {
    report_id: report.reportId,
    status: report.status,
    charge_nano_usd: report.chargeNanoUsd
  };

  if (report.usage !== undefined) {
    const usage: Record<string, number> = {};
    if (report.usage.inputTokens !== undefined) usage.input_tokens = report.usage.inputTokens;
    if (report.usage.outputTokens !== undefined) usage.output_tokens = report.usage.outputTokens;
    if (report.usage.cachedInputTokens !== undefined) usage.cached_input_tokens = report.usage.cachedInputTokens;
    if (report.usage.reasoningTokens !== undefined) usage.reasoning_tokens = report.usage.reasoningTokens;
    body.usage = usage;
  }
  if (report.finishReason !== undefined) body.finish_reason = report.finishReason;
  if (report.providerResponseId !== undefined) body.provider_response_id = report.providerResponseId;
  if (report.delivery !== undefined) {
    body.delivery = { output_started: report.delivery.outputStarted, output_completed: report.delivery.outputCompleted };
  }
  if (report.timing !== undefined) {
    body.timing = { started_at: report.timing.startedAt, ended_at: report.timing.endedAt };
  }
  if (report.errorCategory !== undefined) body.error_category = report.errorCategory;

  // Strict out. A report the SDK built wrongly is observed like any other
  // undeliverable report: the operation will simply expire, charging nothing.
  const validated = validateReportPremiumTerminalRequest(body);
  if (!validated.ok) {
    client.onTerminalReportError?.(
      new EnlittConfigurationError(
        `The premium terminal report is invalid and was not sent: ${validated.error.message} (${validated.error.param}).`
      )
    );
    return;
  }

  try {
    const response = await reportEnlittPremiumTerminal(client, {
      path: terminalReportPath(operation.operationId),
      body: validated.value,
      callId: report.reportId,
      accept: "application/json"
    });
    const parsed = validateReportPremiumTerminalResponse(await readEnlittJson(response), { mode: "tolerant" });
    if (!parsed.ok) {
      client.onTerminalReportError?.(
        new EnlittError(
          "malformed_response",
          `Enlitt's terminal report response could not be validated: ${parsed.error.message} (${parsed.error.param}).`
        )
      );
    }
  } catch (thrown) {
    // `reportEnlittPremiumTerminal()` already delivered a transport or refusal
    // failure to `client.onTerminalReportError` before rethrowing it; a body
    // that could not be read is reported here. Neither reaches the caller.
    if (thrown instanceof EnlittError && thrown.code === "malformed_response") {
      client.onTerminalReportError?.(thrown);
    } else if (!(thrown instanceof EnlittError)) {
      client.onTerminalReportError?.(normalizeEnlittModelError(thrown, false));
    }
  }
}

// --- The lifecycle ---------------------------------------------------------

/**
 * Whether `run` rejected because the call was canceled: the request's own
 * signal is aborted, or the error is an `AbortError`.
 */
export function isCancellation(thrown: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) {
    return true;
  }
  return typeof thrown === "object" && thrown !== null && (thrown as { name?: unknown }).name === "AbortError";
}

/**
 * Wraps exactly one model call: begins one operation, runs `run` only after
 * admission, and sends exactly one terminal report.
 *
 * - **Begin.** `request.callId` when supplied (validated against the protocol's
 *   `Idempotency-Key` bounds), otherwise a fresh random ID. A refusal,
 *   authentication failure, or transport failure rejects with the typed error
 *   and `run` is never called.
 * - **Run.** `run` receives a `charge` function and the admitted operation.
 *   `charge(amount)` records the amount to report; the last call wins.
 * - **Status.** `run` resolving is `completed`. `run` rejecting while
 *   `request.signal` is aborted, or with an `AbortError`, is `canceled`. Any
 *   other rejection is `failed`. The status is decided by how `run` settles,
 *   never by the caller naming one, so a caller cannot report a failure as a
 *   charged cancellation.
 * - **Charge.** `"0"` for `failed`, whatever `charge()` received (a failed call
 *   is always free). For `completed` and `canceled`, the last amount passed to
 *   `charge()`, or `"0"` if never called, lowered to the effective maximum
 *   without an error.
 * - **Report.** One `PremiumTerminalReport` with a `reportId` generated once,
 *   awaited before settling so a serverless process cannot end between the
 *   call and its report.
 * - **Result.** `run`'s value, or `run`'s own error unchanged.
 */
export async function runPremiumCharge<T>(
  client: InternalEnlittClient,
  request: PremiumChargeRequest,
  run: (charge: PremiumChargeFunction, operation: PremiumChargeHandle) => Promise<T>
): Promise<T> {
  const callId = assertCallId(request.callId ?? generateRandomCallId());
  const operation = await beginPremiumOperation(client, request, callId);

  const startedAt = new Date();
  let recordedChargeNanoUsd = "0";
  let facts: PremiumTerminalFacts = {};
  let reportSent = false;

  const charge: PremiumChargeFunction = (amountNanoUsd) => {
    if (reportSent) {
      throw new EnlittConfigurationError("charge() was called after the terminal report was sent.");
    }
    recordedChargeNanoUsd = assertNanoUsd(amountNanoUsd, "charge amount");
  };

  const handle: PremiumChargeHandle = {
    operationId: operation.operationId,
    effectiveMaxChargeNanoUsd: operation.effectiveMaxChargeNanoUsd,
    terminalDeadline: operation.terminalDeadline,
    describe: (next) => {
      facts = next;
    }
  };

  /** Builds and sends the one report for the status `run` settled with. */
  const report = async (status: PremiumTerminalReport["status"]): Promise<void> => {
    reportSent = true;
    const effective = BigInt(operation.effectiveMaxChargeNanoUsd);
    const recorded = BigInt(recordedChargeNanoUsd);
    const chargeNanoUsd =
      status === "failed" ? "0" : recorded > effective ? operation.effectiveMaxChargeNanoUsd : recordedChargeNanoUsd;

    await reportPremiumTerminalState(client, operation, {
      // The describe() timing wins when the business supplied one; otherwise
      // the lifecycle's own bracket around `run` is the best content-free fact.
      timing: { startedAt: startedAt.toISOString(), endedAt: new Date().toISOString() },
      ...facts,
      reportId: crypto.randomUUID(),
      status,
      chargeNanoUsd
    });
  };

  let value: T;
  try {
    value = await run(charge, handle);
  } catch (thrown) {
    await report(isCancellation(thrown, request.signal) ? "canceled" : "failed");
    // Rethrown unchanged: Enlitt adds nothing to, and wraps nothing of, what
    // the business's code threw.
    throw thrown;
  }

  await report("completed");
  return value;
}

/**
 * Accounts one premium model call made by code outside the Vercel AI SDK: a
 * direct provider SDK call, a raw `fetch`, anything the business runs itself.
 *
 * It performs `enlitt()`'s construction checks (server runtime, business
 * secret, base URL) by building one internal client from the `EnlittOptions`
 * fields, validates `maxCharge`, `idempotencyKey`, `reportingDeadlineMs`, and
 * `metadata` under the same rules the Vercel adapter applies, and delegates to
 * {@link runPremiumCharge} with `idempotencyKey` as the call ID. Every failure
 * of those checks is an `EnlittConfigurationError` before any request.
 *
 * It is one model call. A loop of calls is a loop of `withPremiumCharge()`
 * calls; retrying the same call with the same `idempotencyKey` replays that
 * operation instead of charging again.
 */
export async function withPremiumCharge<T>(
  options: WithPremiumChargeOptions,
  run: (charge: PremiumChargeFunction, operation: PremiumChargeHandle) => Promise<T>
): Promise<T> {
  const client = createInternalClient({
    ...(options.secretKey !== undefined ? { secretKey: options.secretKey } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
    ...(options.onTerminalReportError !== undefined ? { onTerminalReportError: options.onTerminalReportError } : {})
  });

  const maxCharge = assertNanoUsd(options.maxCharge, "maxCharge");
  const callId =
    options.idempotencyKey !== undefined
      ? assertIdempotencyKeyBase(options.idempotencyKey, "idempotencyKey")
      : undefined;
  const reportingDeadlineMs =
    options.reportingDeadlineMs !== undefined
      ? assertReportingDeadlineMs(options.reportingDeadlineMs, "reportingDeadlineMs")
      : undefined;
  const metadata =
    options.metadata !== undefined ? assertCallerMetadata(options.metadata, "metadata") : undefined;

  return runPremiumCharge(
    client,
    {
      maxCharge,
      provider: { id: options.provider.id, model: options.provider.model },
      ...(callId !== undefined ? { callId } : {}),
      ...(reportingDeadlineMs !== undefined ? { reportingDeadlineMs } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {})
    },
    run
  );
}
