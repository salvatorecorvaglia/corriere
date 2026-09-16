/**
 * Runs `body()` while `value` is marked in `visited`, guaranteeing the mark is removed
 * afterward — including when `body()` throws. Marking only the current recursion *path*
 * (not every object ever seen) lets the same object legitimately appear more than once in
 * the output, e.g. `{ a: shared, b: shared }`, while still breaking true cycles: a value
 * that recursively contains itself is still marked when the recursion reaches it again.
 *
 * `onCycle()` runs instead of `body()` when `value` is already on the current path.
 */
export function withCycleGuard<T>(
  value: object,
  visited: WeakSet<object>,
  body: () => T,
  onCycle: () => T,
): T {
  if (visited.has(value)) return onCycle();
  visited.add(value);
  try {
    return body();
  } finally {
    visited.delete(value);
  }
}
