/**
 * Application-level error types for TSLOR.
 *
 * {@code CliError} signals CLI-level failures that result in a non-zero
 * exit code.
 */

interface CliErrorOptions {
  exitCode?: number;
  cause?: unknown;
  /**
   * When true, the error represents an unexpected internal failure and
   * the error handler should print the cause's stack trace for debugging.
   * When false (default), the error is an expected user-facing error
   * (e.g. bad path) and no stack is printed.
   */
  unexpected?: boolean;
}

/**
 * Error thrown for CLI-level failures that should result in a non-zero exit code.
 *
 * Preferred over {@code process.exit()} so the top-level catch in
 * {@code main()} controls formatting and exit behavior uniformly.
 */
export class CliError extends Error {
  public readonly exitCode: number;
  public readonly unexpected: boolean;

  constructor(message: string, opts: CliErrorOptions) {
    super(message, { cause: opts?.cause });
    this.name = new.target.name;
    this.exitCode = opts?.exitCode ?? 1;
    this.unexpected = opts?.unexpected ?? false;
  }
}

/**
 * Re-throw error as CliError, passing through existing CliError
 * unchanged to preserve type identity for instanceof checks. For
 * non-CliError inputs, the original error is preserved as `cause`.
 *
 * @param error - The original error
 * @param context - Context prefix for the error message
 * @param unexpected - Whether this is an unexpected internal failure (prints cause stack trace)
 */
export function reThrowAsCliError(
  error: unknown,
  context: string,
  unexpected: boolean,
): never {
  if (error instanceof CliError) {
    throw error;
  }
  const msg = error instanceof Error ? error.message : String(error);
  throw new CliError(`${context}: ${msg}`, { cause: error, unexpected });
}
