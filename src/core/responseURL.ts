/** Retain the sent URL when custom fetch responses have an empty Response.url. */
const requestURLs = new WeakMap<Response, { requested: string; effective: string }>();

export function rememberRequestURL(
  response: Response,
  requested: string,
  effective = requested,
): void {
  requestURLs.set(response, { requested, effective });
}

export function requestURLFor(response: Response): string | undefined {
  return requestURLs.get(response)?.requested;
}

export function responseURLFor(response: Response): string | undefined {
  return response?.url || requestURLs.get(response)?.effective;
}
