/**
 * Runtime assertion utility for TSLOR.
 * 
 * This function throws an error if the given condition is false.
 * It is meant to be a safety net to prevent programming mistakes.
 * It MUST NOT BE USED for regular control flow!
 */

type MessageValue = string;
type MessageFormatter = MessageValue | (() => MessageValue);

function toString(msg: MessageValue | (() => MessageValue)): string {
  if (typeof msg === 'function') {
    return msg();
  }
  return msg;
}

/**
 * Asserts that a condition is true, throwing an error with the provided message if not.
 * 
 * @param value - The condition to check
 * @param message - Error message (can be a string or function that returns a string)
 */
export function invariant(value: unknown, message: MessageFormatter): asserts value {
  if (!value) {
    const msg = toString(message);
    throw new Error(msg);
  }
}

/**
 * Type-safe assertion that a value is not null or undefined.
 * 
 * @param value - The value to check
 * @param message - Error message if value is null/undefined
 */
export function assertDefined<T>(value: T | null | undefined, message: MessageFormatter): asserts value is T {
  invariant(value != null, message);
}