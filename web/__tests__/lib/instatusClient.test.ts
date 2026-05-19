/** @jest-environment node */

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import {
  getInstatusConfigFromEnv,
  setInstatusComponentStatus,
  statusForHealth,
  validateInstatusConfig,
} from '@/lib/instatusClient';

function response(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('instatusClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps health booleans to component statuses', () => {
    expect(statusForHealth(true)).toBe('OPERATIONAL');
    expect(statusForHealth(false)).toBe('DEGRADEDPERFORMANCE');
  });

  it('loads component ids from env vars', () => {
    const config = getInstatusConfigFromEnv({
      INSTATUS_API_KEY: 'secret',
      INSTATUS_PAGE_ID: 'page-1',
      INSTATUS_COMPONENT_API_ID: 'component-api',
    });

    expect(config.apiKey).toBe('secret');
    expect(config.pageId).toBe('page-1');
    expect(config.componentIds.api).toBe('component-api');
    expect(config.componentStatusMethod).toBe('PUT');
    expect(config.apiBaseUrl).toBe('https://api.instatus.com');
  });

  it('validates all required status page component config', () => {
    const result = validateInstatusConfig({
      apiKey: 'secret',
      pageId: 'page-1',
      apiBaseUrl: 'https://api.instatus.com',
      componentStatusMethod: 'PUT',
      componentStatusUrlTemplate: '',
      componentIds: { api: 'component-api' },
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toContain('INSTATUS_COMPONENT_DASHBOARD_ID');
    expect(result.missing).not.toContain('INSTATUS_COMPONENT_API_ID');
  });

  it('skips publishing when required config is missing', async () => {
    const result = await setInstatusComponentStatus('api', 'OPERATIONAL', {
      apiKey: '',
      pageId: 'page-1',
      apiBaseUrl: 'https://api.instatus.com',
      componentStatusMethod: 'PUT',
      componentStatusUrlTemplate: '',
      componentIds: { api: 'component-api' },
    });

    expect(result).toEqual({
      component: 'api',
      status: 'OPERATIONAL',
      ok: false,
      skipped: true,
      error: 'missing INSTATUS_API_KEY',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('publishes status to the default component endpoint', async () => {
    mockFetch.mockResolvedValueOnce(response(200, '{}'));

    const result = await setInstatusComponentStatus('api', 'DEGRADEDPERFORMANCE', {
      apiKey: 'secret',
      pageId: 'page-1',
      apiBaseUrl: 'https://api.instatus.com',
      componentStatusMethod: 'PUT',
      componentStatusUrlTemplate: '',
      componentIds: { api: 'component-api' },
    });

    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.instatus.com/v2/page-1/components/component-api',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ status: 'DEGRADEDPERFORMANCE' }),
      }),
    );
  });

  it('supports a page-aware endpoint template override', async () => {
    mockFetch.mockResolvedValueOnce(response(200));

    await setInstatusComponentStatus('dashboard', 'OPERATIONAL', {
      apiKey: 'secret',
      pageId: 'page-1',
      apiBaseUrl: 'https://ignored.example',
      componentStatusMethod: 'PATCH',
      componentStatusUrlTemplate: 'https://api.example.test/{pageId}/component/{componentId}',
      componentIds: { dashboard: 'component-dashboard' },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.test/page-1/component/component-dashboard',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('returns API failure details without throwing', async () => {
    mockFetch.mockResolvedValueOnce(response(422, 'bad status'));

    const result = await setInstatusComponentStatus('api', 'OPERATIONAL', {
      apiKey: 'secret',
      pageId: 'page-1',
      apiBaseUrl: 'https://api.instatus.com',
      componentStatusMethod: 'PUT',
      componentStatusUrlTemplate: '',
      componentIds: { api: 'component-api' },
    });

    expect(result).toEqual({
      component: 'api',
      status: 'OPERATIONAL',
      ok: false,
      statusCode: 422,
      error: 'bad status',
    });
  });

  it('returns network failure details without throwing', async () => {
    mockFetch.mockRejectedValueOnce(new Error('socket closed'));

    const result = await setInstatusComponentStatus('api', 'OPERATIONAL', {
      apiKey: 'secret',
      pageId: 'page-1',
      apiBaseUrl: 'https://api.instatus.com',
      componentStatusMethod: 'PUT',
      componentStatusUrlTemplate: '',
      componentIds: { api: 'component-api' },
    });

    expect(result).toMatchObject({
      component: 'api',
      status: 'OPERATIONAL',
      ok: false,
      error: 'socket closed',
    });
  });
});
