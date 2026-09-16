export default function parseHeaders(headers: any): Record<string, string | string[]> {
  const parsed: Record<string, string | string[]> = {};

  if (!headers) return parsed;

  const addHeader = (key: string, value: string | string[]) => {
    const k = key.toLowerCase();
    const values = Array.isArray(value) ? value : [value];
    for (const val of values) {
      if (Object.hasOwn(parsed, k)) {
        if (Array.isArray(parsed[k])) {
          (parsed[k] as string[]).push(val);
        } else {
          parsed[k] = [parsed[k] as string, val];
        }
      } else {
        parsed[k] = val;
      }
    }
  };

  if (typeof headers.forEach === 'function') {
    headers.forEach((value: string, key: string) => {
      addHeader(key, value);
    });
    if (typeof headers.getSetCookie === 'function') {
      const cookies = headers.getSetCookie();
      if (cookies && cookies.length > 0) {
        parsed['set-cookie'] = cookies;
      }
    }
    return parsed;
  }

  if (typeof headers === 'string') {
    headers.split('\n').forEach((line: string) => {
      const index = line.indexOf(':');
      if (index > 0) {
        const key = line.substring(0, index).trim();
        const value = line.substring(index + 1).trim();
        addHeader(key, value);
      }
    });
    return parsed;
  }

  if (typeof headers === 'object') {
    Object.keys(headers).forEach((key) => {
      addHeader(key, headers[key]);
    });
    return parsed;
  }

  return parsed;
}
