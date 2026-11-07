/**
 * The canonical base-10 integer string, defined once for both sides of the
 * wire.
 *
 * `specs/PROTOCOLS.md` transports every credit and NANOUSD amount as a string
 * of digits with no sign, fraction, exponent, or noncanonical leading zero, so
 * that an exact `bigint` survives JSON without ever touching a float. The
 * backend, the SDK, and the frontend all parse and serialize these, and one
 * definition here is the difference between one notion of canonical and three
 * that agree until they do not.
 *
 * The rejection of noncanonical forms is not pedantry. `"007"` and `"7"` are
 * the same number and different strings, and amounts are compared, keyed, and
 * audited as strings elsewhere in the system; accepting both would let one
 * amount have two identities.
 */

/** Digits only. No sign, no fraction, no exponent, no leading zero except `"0"` itself. */
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;

/**
 * Raised when a value is not a canonical base-10 integer string. It is a
 * validation failure on untrusted input, so callers on a request path are
 * expected to catch it and refuse the request.
 */
export class CanonicalIntegerError extends Error {
  override readonly name = "CanonicalIntegerError";
}

export function isCanonicalIntegerString(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_INTEGER.test(value);
}

/**
 * Parse a canonical base-10 integer string into an exact `bigint`.
 *
 * `field` names the wire field for the error message only; it never reaches a
 * response body on its own.
 */
export function parseCanonicalInteger(value: unknown, field = "amount"): bigint {
  if (typeof value !== "string") {
    throw new CanonicalIntegerError(
      `${field} must be a canonical base-10 integer string, not ${typeof value}`
    );
  }
  if (!CANONICAL_INTEGER.test(value)) {
    throw new CanonicalIntegerError(
      `${field} must be digits only with no sign, fraction, exponent, or leading zero`
    );
  }
  return BigInt(value);
}

/**
 * Parse a canonical integer that must be strictly positive.
 *
 * A premium quote uses this: zero is not a quote, and rounding a strictly
 * positive quote up is what makes a per-call limit of zero an absolute block
 * rather than a free pass for amounts too small to reach one credit.
 */
export function parsePositiveCanonicalInteger(value: unknown, field = "amount"): bigint {
  const parsed = parseCanonicalInteger(value, field);
  if (parsed <= 0n) {
    throw new CanonicalIntegerError(`${field} must be strictly positive`);
  }
  return parsed;
}

/**
 * Serialize a nonnegative `bigint` to its canonical string form.
 *
 * Negative values are refused rather than serialized with a sign: no amount on
 * this wire is negative, and a negative one reaching the wire would mean a
 * balance calculation went wrong somewhere upstream of here.
 */
export function formatCanonicalInteger(value: bigint, field = "amount"): string {
  if (typeof value !== "bigint") {
    throw new CanonicalIntegerError(`${field} must be a bigint to serialize exactly`);
  }
  if (value < 0n) {
    throw new CanonicalIntegerError(`${field} must not be negative`);
  }
  return value.toString(10);
}
