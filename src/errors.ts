/**
 * Application-level error types for TSLOR.
 *
 * {@code CliError} signals CLI-level failures that result in a non-zero
 * exit code.
 */

/**
 * Whether a {@link CliError} is an expected, user-facing error (bad path,
 * missing input file, checksum mismatch — the user sees a single clean
 * `tslor: <message>` line, no stack trace) or an unexpected internal
 * failure (worker crash, native I/O fault, a bug — the cause's stack
 * trace is additionally printed for diagnosis). A string literal rather
 * than a boolean so a taxonomy change at a call site is a whole-word diff
 * (`'expected'` → `'unexpected'`), not a one-character flip easy to miss
 * while skimming a larger refactor.
 */
export type ErrorExpectedness = 'expected' | 'unexpected';

interface CliErrorOptions {
  exitCode?: number;
  cause?: unknown;
  expectedness?: ErrorExpectedness;
}

/**
 * Error thrown for CLI-level failures that should result in a non-zero exit code.
 *
 * Preferred over {@code process.exit()} so the top-level catch in
 * {@code main()} controls formatting and exit behavior uniformly.
 */
export class CliError extends Error {
  public readonly exitCode: number;
  public readonly expectedness: ErrorExpectedness;

  constructor(message: string, opts: CliErrorOptions) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.exitCode = opts.exitCode ?? 1;
    this.expectedness = opts.expectedness ?? 'expected';
  }
}

/**
 * Re-throw error as CliError, passing through existing CliError
 * unchanged to preserve type identity for instanceof checks. For
 * non-CliError inputs, the original error is preserved as `cause`.
 *
 * @param error - The original error
 * @param context - Context prefix for the error message
 * @param expectedness - 'expected' or 'unexpected'; see {@link ErrorExpectedness}
 */
export function reThrowAsCliError(
  error: unknown,
  context: string,
  expectedness: ErrorExpectedness,
): never {
  if (error instanceof CliError) {
    throw error;
  }
  const msg = error instanceof Error ? error.message : String(error);
  throw new CliError(`${context}: ${msg}`, { cause: error, expectedness });
}
