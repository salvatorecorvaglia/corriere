import { withCycleGuard } from './cycleGuard';
import { isBinaryData } from './isBinary';

/**
 * The form field name for `key` nested under `namespace`: `ns[key]` with brackets, `ns.key`
 * without, or just `key` at the top level. Array and `Set` positions always use brackets.
 */
function childKey(namespace: string | undefined, key: string, brackets: boolean): string {
  if (!namespace) return key;
  return brackets ? `${namespace}[${key}]` : `${namespace}.${key}`;
}

export function toFormData(
  obj: any,
  form?: FormData,
  namespace?: string,
  seen?: WeakSet<any>,
  options?: { brackets?: boolean },
): FormData {
  const fd = form || new FormData();

  if (obj === null || obj === undefined) {
    return fd;
  }

  const visited = seen || new WeakSet<any>();
  const brackets = options?.brackets ?? false;

  if (obj instanceof Date) {
    fd.append(namespace || '', obj.toISOString());
  } else if (obj instanceof Map) {
    // Map/Set store their data internally, not as own-enumerable properties, so the generic
    // `Object.keys(obj)` branch below sees them as empty and silently drops the field.
    withCycleGuard(
      obj,
      visited,
      () => {
        for (const [key, value] of obj.entries()) {
          toFormData(value, fd, childKey(namespace, String(key), brackets), visited, options);
        }
      },
      () => {},
    );
  } else if (obj instanceof Set) {
    withCycleGuard(
      obj,
      visited,
      () => {
        let index = 0;
        for (const value of obj.values()) {
          toFormData(value, fd, childKey(namespace, String(index), true), visited, options);
          index++;
        }
      },
      () => {},
    );
  } else if (typeof obj === 'object' && !isBinaryData(obj)) {
    // Marks the current path only — unmarking on the way out breaks cycles while still
    // emitting an object that legitimately appears under two different keys.
    withCycleGuard(
      obj,
      visited,
      () => {
        const isArray = Array.isArray(obj);
        for (const key of Object.keys(obj)) {
          toFormData(obj[key], fd, childKey(namespace, key, isArray || brackets), visited, options);
        }
      },
      () => {},
    );
  } else {
    fd.append(namespace || '', obj);
  }

  return fd;
}
