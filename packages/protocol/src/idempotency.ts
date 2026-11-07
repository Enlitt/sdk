/**
 * Idempotency-key validation and conflict classification, defined once.
 *
 * Three mechanisms in three documents share this one shape: the
 * application-scoped `Idempotency-Key` with its three `409` outcomes, the
 * globally unique key on `financial_transactions`, and the provider event ID on
 * webhooks. Each of them validates a key, looks up the prior effect, and
 * classifies the request as a replay, a conflict, or a new operation. Owning
 * that classification here is what keeps the three `409`s from drifting apart
 * as each endpoint is written.
 */

import type { EnlittErrorCode } from "./errors.js";

/** `specs/PROTOCOLS.md`: 16–255 visible ASCII characters. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 16;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
export const IDEMPOTENCY_KEY_MIN_RETENTION_DAYS = 30;

/**
 * Visible ASCII excludes both the space and every control character. A key is
 * echoed into logs and used as part of a database key, so anything that could
 * be invisible, trimmed, or normalized differently by an intermediary is
 * refused rather than accepted and silently altered.
 */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

export class IdempotencyKeyError extends Error {
  override readonly name = "IdempotencyKeyError";
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= IDEMPOTENCY_KEY_MIN_LENGTH &&
    value.length <= IDEMPOTENCY_KEY_MAX_LENGTH &&
    VISIBLE_ASCII.test(value)
  );
}

/**
 * Validate an `Idempotency-Key` header value, returning it unchanged.
 *
 * It is returned rather than normalized on purpose. Trimming or lowercasing
 * here would make two distinct keys collide at the database and turn one
 * business's two calls into one, so the value that is validated is the value
 * that is stored.
 */
export function assertIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new IdempotencyKeyError("Idempotency-Key is required");
  }
  if (value.length < IDEMPOTENCY_KEY_MIN_LENGTH || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new IdempotencyKeyError(
      `Idempotency-Key must be between ${IDEMPOTENCY_KEY_MIN_LENGTH} and ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`
    );
  }
  if (!VISIBLE_ASCII.test(value)) {
    throw new IdempotencyKeyError("Idempotency-Key must contain only visible ASCII characters");
  }
  return value;
}

/** Whether the operation a key already created has reached a terminal state. */
export type IdempotentOperationStatus = "active" | "terminal";

/**
 * What a prior use of this key left behind, as the caller's own lookup found
 * it. `requestFingerprint` is the caller's canonical digest of the request that
 * created the operation; this module compares it and never computes it, because
 * what counts as canonical input differs between a response creation and a
 * premium operation start.
 */
export interface PriorIdempotentOperation {
  readonly operationId: string;
  readonly status: IdempotentOperationStatus;
  readonly requestFingerprint: string;
  /**
   * Reserved for a future expiry policy. The current implementation retains
   * keys indefinitely and deliberately ignores this value; the public promise
   * is only that uniqueness lasts at least `IDEMPOTENCY_KEY_MIN_RETENTION_DAYS`.
   */
  readonly expiresAt?: Date;
}

export type IdempotencyClassification =
  | { readonly kind: "new" }
  | { readonly kind: "conflict"; readonly code: EnlittErrorCode }
  | {
      readonly kind: "in_progress";
      readonly code: EnlittErrorCode;
      readonly operationId: string;
    }
  | {
      readonly kind: "replay_unavailable";
      readonly code: EnlittErrorCode;
      readonly operationId: string;
    };

export interface ClassifyIdempotencyInput {
  readonly requestFingerprint: string;
  readonly prior: PriorIdempotentOperation | null;
  readonly now: Date;
}

/**
 * Classify a request against whatever the key has already done.
 *
 * All three refusals are `409` and all three are permanently non-retryable: an
 * automatic retry of a conflict cannot resolve it and can only multiply it.
 * None of them reruns the call, reserves twice, invokes a provider again, or
 * replays output — the operation ID and status are the only facts a caller
 * gets back, and they are safe to disclose because the caller created the
 * operation in the first place.
 */
export function classifyIdempotentRequest(
  input: ClassifyIdempotencyInput
): IdempotencyClassification {
  const { prior } = input;
  if (prior === null) {
    return { kind: "new" };
  }

  if (prior.requestFingerprint !== input.requestFingerprint) {
    return { kind: "conflict", code: "conflict_error" };
  }

  if (prior.status === "active") {
    return {
      kind: "in_progress",
      code: "operation_in_progress",
      operationId: prior.operationId
    };
  }

  return {
    kind: "replay_unavailable",
    code: "idempotency_replay_unavailable",
    operationId: prior.operationId
  };
}
