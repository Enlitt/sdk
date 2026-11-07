/**
 * Version and tolerant-reading vocabulary shared by every protocol parser.
 *
 * These are wire values, not application configuration. Keeping them here
 * makes a client built from this package send the exact contract date and use
 * the same reserved values as every other client.
 */
export const ENLITT_API_VERSION = "2026-10-05";
export const ENLITT_VERSION_HEADER = "Enlitt-Version";
export const UNKNOWN_ENUM_VALUE = "other";
export const UNRECOGNIZED_ERROR_CODE = "unrecognized";

export type ParseMode = "strict" | "tolerant";

/** An omitted mode is strict; only response readers opt into tolerant mode. */
export interface ParseOptions {
  readonly mode?: ParseMode;
}

/** A closed response enum after a tolerant reader sees a future member. */
export type Readable<T extends string> = T | typeof UNKNOWN_ENUM_VALUE;

/** A future discriminated response variant whose remaining fields cannot be trusted. */
export interface UnknownVariant {
  readonly unknown: true;
  readonly type: string;
}
