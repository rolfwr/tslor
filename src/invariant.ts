/**
 * Runtime assertion utilities for TSLOR.
 *
 * Provides invariant checks for programming guarantees and a helper
 * that replaces non-null assertions on known-safe Map lookups.
 */

type MessageValue = string;
type MessageFormatter = MessageValue | (() => MessageValue);

function toString(msg: MessageFormatter): string {
  if (typeof msg === 'function') {
    return msg();
  }
  return msg;
}

/**
 * Asserts that a condition is true, throwing an error with the provided message if not.
 *
 * Safety net for programming mistakes only — must not be used for regular
 * control flow. Throws a plain {@code Error} (not {@code CliError}) so that
 * invariant violations surface stack traces for debugging rather than being
 * swallowed as user-facing CLI errors.
 *
 * @param value - The condition to check
 * @param message - Error message (can be a string or function that returns a string)
 */
export function invariant(
  value: unknown,
  message: MessageFormatter,
): asserts value {
  if (!value) {
    const msg = toString(message);
    throw new Error(msg);
  }
}

/**
 * Type-safe assertion that a value is not null or undefined.
 *
 * Use this function when a value being `null` signifies a programming bug in
 * the code, and it's not trivial to prove that such bugs cannot exist.
 *
 * Use this function in test cases as a replacement for assert.isDefined() whose
 * definition is missing `asserts value is NonNullable<T>` that tells the
 * TypeScript compiler about the resulting type guarantees.
 *
 * Do not use this function to placate false positives in static analysis tools,
 * when we trivially can see that a null value can never happen at runtime. For
 * such cases, either fix type uncertainty at its source, or if that is not
 * possible, locally disable the specific false positive diagnostics with a
 * comment directive, and provide a rationale for why the code is trivially
 * correct.
 *
 * @param value - The value to check
 * @param message - Error message if value is null/undefined
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message: MessageFormatter,
): asserts value is NonNullable<T> {
  invariant(value != null, message);
}

/**
 * Retrieve a value from a Map, throwing if the key is missing.
 *
 * Replaces the need for non-null assertions (`!`) on `Map.get()` calls
 * where the caller guarantees the key exists.
 *
 * @param map - The map to look up
 * @param key - The key to retrieve
 * @param message - Error message if the key is not present
 * @returns The value associated with the key
 */
export function getOrThrow<K, V>(
  map: ReadonlyMap<K, V>,
  key: K,
  message: MessageFormatter,
): V {
  const value = map.get(key);
  assertDefined(value, message);
  return value;
}
