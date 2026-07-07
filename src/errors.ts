/**
 * Application-level error types for TSLOR.
 *
 * {@code CliError} signals CLI-level failures that result in a non-zero
 * exit code.
 */

interface CliErrorOptions {
  exitCode?: number;
  cause?: unknown;
}

/**
 * Error thrown for CLI-level failures that should result in a non-zero exit code.
 *
 * Preferred over {@code process.exit()} so the top-level catch in
 * {@code main()} controls formatting and exit behavior uniformly.
 */
export class CliError extends Error {
  public readonly exitCode: number;

  constructor(message: string, opts?: CliErrorOptions) {
    super(message, { cause: opts?.cause });
    this.name = new.target.name;
    this.exitCode = opts?.exitCode ?? 1;
  }
}

/**
 * Re-throw error as CliError, passing through existing CliError
 * unchanged to preserve type identity for instanceof checks. For
 * non-CliError inputs, the original error is preserved as `cause`.
 *
 * @param error - The original error
 * @param context - Context prefix for the error message
 */
export function reThrowAsCliError(error: unknown, context: string): never {
  if (error instanceof CliError) {
    throw error;
  }
  const msg = error instanceof Error ? error.message : String(error);
  throw new CliError(`${context}: ${msg}`, { cause: error });
}
