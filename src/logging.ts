/**
 * Opt-in logging for the BillKit SDK.
 *
 * A library has no business deciding where its host application's logs
 * go, so this SDK ships no logger, no transport, and no destination. It
 * accepts one from you and writes to a no-op until you do:
 *
 * ```ts
 * const client = new BillKit({ logger: console });
 * ```
 *
 * `console` satisfies {@link BillKitLogger} structurally, so that line
 * works with no adapter. So does a pino/winston/bunyan child logger:
 * their `debug(msg, ctx)` / `warn(msg, ctx)` signatures line up. If yours
 * takes its arguments the other way round, wrap it:
 *
 * ```ts
 * const logger = {
 *   debug: (m, c) => myLogger.debug(c, m),
 *   warn: (m, c) => myLogger.warn(c, m),
 * };
 * ```
 *
 * ## What gets logged
 *
 * - **debug**: one call per HTTP attempt and one per response, with
 *   `method`, `url`, `attempt`, `status`, `durationMs`, and `requestId`
 *   (quote that id to BillKit support).
 * - **warn**: one call per retry, naming the reason and the delay before
 *   the next attempt. A retry is a real anomaly worth surfacing without
 *   being an error.
 *
 * ## What is deliberately never logged
 *
 * - The `Authorization` header or the API key, in any form.
 * - Request and response **bodies**. They carry customer PII (emails,
 *   names, addresses) and billing detail; a payments SDK that quietly
 *   copies those into its user's log sink has manufactured a compliance
 *   problem on their behalf.
 * - The **query string**. List filters routinely carry values like
 *   `email=ada@example.com`, so only the path is logged.
 * - The **final failure**. Every exhausted call throws a typed
 *   `BillKitError` carrying the status, request id and retry-after;
 *   logging it here as well would produce a duplicate the caller never
 *   asked for and cannot suppress from their own sink.
 */

/** Structured context attached to a log line. Never contains secrets. */
export type LogContext = Record<string, unknown>;

/**
 * The minimum a logger must do for the SDK to use it. Deliberately two
 * methods: the SDK has exactly two things to say, and a narrow interface
 * is one almost every logger already satisfies without an adapter.
 */
export interface BillKitLogger {
  debug(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
}

/**
 * The default. Discards everything, so the SDK is silent until a logger
 * is supplied, and costs nothing when it isn't.
 */
export const NOOP_LOGGER: BillKitLogger = {
  debug(): void {
    /* intentionally empty */
  },
  warn(): void {
    /* intentionally empty */
  },
};
