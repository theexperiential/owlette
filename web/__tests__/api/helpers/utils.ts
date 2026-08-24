/** Mock factories for API route-handler tests. */

import { NextRequest } from 'next/server';

/** Build a NextRequest against http://localhost. */
export function createMockRequest(
  url: string,
  options?: {
    method?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  }
): NextRequest {
  const { method = 'GET', body, headers = {} } = options || {};

  const init: RequestInit = { method, headers };

  if (body && method !== 'GET' && method !== 'HEAD') {
    init.body = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }

  // NextRequest wants its own stricter RequestInit; cast bridges the mismatch.
  return new NextRequest(new URL(url, 'http://localhost'), init as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

/** Status + parsed JSON body from a NextResponse. */
export async function parseResponse(response: Response): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return {
    status: response.status,
    body: await response.json(),
  };
}
