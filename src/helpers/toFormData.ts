import { withCycleGuard } from './cycleGuard';

export function toFormData(
  obj: any,
  form?: FormData,
  namespace?: string,
  seen?: WeakSet<any>,
  options?: { brackets?: boolean },
): FormData {
  const fd = form || new FormData();
  let formKey: string;

  if (obj === null || obj === undefined) {
    return fd;
  }

  const visited = seen || new WeakSet<any>();

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
          const useBrackets = options?.brackets ?? false;
          const strKey = String(key);
          formKey = namespace
            ? useBrackets
              ? `${namespace}[${strKey}]`
              : `${namespace}.${strKey}`
            : strKey;
          toFormData(value, fd, formKey, visited, options);
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
          formKey = namespace ? `${namespace}[${index}]` : String(index);
          toFormData(value, fd, formKey, visited, options);
          index++;
        }
      },
      () => {},
    );
  } else if (
    typeof obj === 'object' &&
    !(typeof File !== 'undefined' && obj instanceof File) &&
    !(typeof Blob !== 'undefined' && obj instanceof Blob) &&
    !(typeof ArrayBuffer !== 'undefined' && obj instanceof ArrayBuffer) &&
    !(typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(obj)) &&
    !(typeof Buffer !== 'undefined' && Buffer.isBuffer(obj))
  ) {
    // Marks the current path only — unmarking on the way out breaks cycles while still
    // emitting an object that legitimately appears under two different keys.
    withCycleGuard(
      obj,
      visited,
      () => {
        Object.keys(obj).forEach((key) => {
          if (Array.isArray(obj)) {
            formKey = namespace ? `${namespace}[${key}]` : key;
          } else {
            const useBrackets = options?.brackets ?? false;
            formKey = namespace
              ? useBrackets
                ? `${namespace}[${key}]`
                : `${namespace}.${key}`
              : key;
          }
          toFormData(obj[key], fd, formKey, visited, options);
        });
      },
      () => {},
    );
  } else {
    fd.append(namespace || '', obj);
  }

  return fd;
}
