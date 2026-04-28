/** @jest-environment node */

import { apiError } from '@/lib/apiErrorResponse';
import { ProblemType } from '@/lib/apiErrors';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

describe('apiErrorResponse legacy helper', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('returns the shared problem+json envelope with a compatibility error alias', async () => {
    const res = apiError(new Error('database unavailable'), 'account/api-keys');
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json; charset=utf-8');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    expect(body).toMatchObject({
      type: ProblemType.Internal,
      title: 'internal error',
      status: 500,
      code: 'internal_error',
      docsUrl: 'https://owlette.app/docs/api/errors#internal_error',
      instance: 'account/api-keys',
    });
    expect(body.requestId).toBe(res.headers.get('X-Request-Id'));
    expect(body.error).toBe(body.detail);
  });
});
