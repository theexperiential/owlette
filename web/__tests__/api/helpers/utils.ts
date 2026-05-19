/**
 * Shared Test Utilities for API Route Handler Tests
 *
 * Provides mock factories for NextRequest objects and common mock setups.
 */

import { NextRequest } from 'next/server';

/**
 * Create a NextRequest for testing API route handlers.
 */
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

  // NextRequest's constructor wants its own RequestInit type (stricter subset
  // of the DOM one) — cast via unknown to bridge the nominal mismatch.
  return new NextRequest(new URL(url, 'http://localhost'), init as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

/**
 * Helper to extract JSON body from NextResponse.
 */
export async function parseResponse(response: Response): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return {
    status: response.status,
    body: await response.json(),
  };
}
