import { vi } from "vitest";

/**
 * Minimal Response stub for mocking global fetch in unit tests —
 * fetchPullRequests only reads ok/status/statusText/headers/json.
 */
export function makeResponse(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Response {
  const { ok = true, status = 200, statusText = "OK", headers = {}, body = {} } = options;
  return {
    ok,
    status,
    statusText,
    headers: { get: (name: string) => headers[name] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}
