import type { StatusComponent } from '@/lib/healthChecks.server';

export type InstatusComponentStatus =
  | 'OPERATIONAL'
  | 'DEGRADEDPERFORMANCE'
  | 'PARTIALOUTAGE'
  | 'MAJOROUTAGE';

export interface InstatusConfig {
  apiKey: string;
  pageId: string;
  apiBaseUrl: string;
  componentStatusMethod: string;
  componentStatusUrlTemplate: string;
  componentIds: Partial<Record<StatusComponent, string>>;
}

export interface InstatusPublishResult {
  component: StatusComponent;
  status: InstatusComponentStatus;
  ok: boolean;
  skipped?: boolean;
  statusCode?: number;
  error?: string;
}

export interface InstatusConfigValidation {
  ok: boolean;
  missing: string[];
}

export const INSTATUS_COMPONENT_ENV: Record<StatusComponent, string> = {
  dashboard: 'INSTATUS_COMPONENT_DASHBOARD_ID',
  api: 'INSTATUS_COMPONENT_API_ID',
  agent_registry: 'INSTATUS_COMPONENT_AGENT_REGISTRY_ID',
  webhook_delivery: 'INSTATUS_COMPONENT_WEBHOOK_DELIVERY_ID',
  alert_delivery: 'INSTATUS_COMPONENT_ALERT_DELIVERY_ID',
  r2_uploads: 'INSTATUS_COMPONENT_R2_UPLOADS_ID',
  firestore: 'INSTATUS_COMPONENT_FIRESTORE_ID',
  cortex_chat: 'INSTATUS_COMPONENT_CORTEX_CHAT_ID',
};

// Components whose Instatus status-page id is OPTIONAL: they still run as health
// checks and can alert via Sentry, but a missing id must not flip the whole page to
// "not configured" or block the prod-readiness gate (`check-status-page-ready.mjs`).
const OPTIONAL_STATUS_PAGE_COMPONENTS: StatusComponent[] = ['alert_delivery'];

export function getInstatusConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): InstatusConfig {
  const componentIds = Object.fromEntries(
    Object.entries(INSTATUS_COMPONENT_ENV)
      .map(([component, envName]) => [component, env[envName]])
      .filter((entry): entry is [StatusComponent, string] => typeof entry[1] === 'string' && entry[1].length > 0),
  ) as Partial<Record<StatusComponent, string>>;

  return {
    apiKey: env.INSTATUS_API_KEY ?? '',
    pageId: env.INSTATUS_PAGE_ID ?? '',
    apiBaseUrl: (env.INSTATUS_API_BASE_URL ?? 'https://api.instatus.com').replace(/\/+$/, ''),
    componentStatusMethod: env.INSTATUS_COMPONENT_STATUS_METHOD ?? 'PUT',
    componentStatusUrlTemplate: env.INSTATUS_COMPONENT_STATUS_URL_TEMPLATE ?? '',
    componentIds,
  };
}

export function statusForHealth(ok: boolean): InstatusComponentStatus {
  return ok ? 'OPERATIONAL' : 'DEGRADEDPERFORMANCE';
}

function missingConfigReason(
  component: StatusComponent,
  config: InstatusConfig,
): string | null {
  if (!config.apiKey) return 'missing INSTATUS_API_KEY';
  if (!config.pageId) return 'missing INSTATUS_PAGE_ID';
  if (!config.componentIds[component]) return `missing ${INSTATUS_COMPONENT_ENV[component]}`;
  return null;
}

export function validateInstatusConfig(
  config: InstatusConfig = getInstatusConfigFromEnv(),
): InstatusConfigValidation {
  const missing: string[] = [];
  if (!config.apiKey) missing.push('INSTATUS_API_KEY');
  if (!config.pageId) missing.push('INSTATUS_PAGE_ID');

  for (const component of Object.keys(INSTATUS_COMPONENT_ENV) as StatusComponent[]) {
    if (OPTIONAL_STATUS_PAGE_COMPONENTS.includes(component)) continue;
    if (!config.componentIds[component]) missing.push(INSTATUS_COMPONENT_ENV[component]);
  }

  return { ok: missing.length === 0, missing };
}

export async function setInstatusComponentStatus(
  component: StatusComponent,
  status: InstatusComponentStatus,
  config: InstatusConfig = getInstatusConfigFromEnv(),
): Promise<InstatusPublishResult> {
  const missing = missingConfigReason(component, config);
  if (missing) {
    return { component, status, ok: false, skipped: true, error: missing };
  }

  const componentId = config.componentIds[component] as string;
  const url = (config.componentStatusUrlTemplate || `${config.apiBaseUrl}/v2/{pageId}/components/{componentId}`)
    .replace('{pageId}', encodeURIComponent(config.pageId))
    .replace('{componentId}', encodeURIComponent(componentId));

  try {
    const response = await fetch(url, {
      method: config.componentStatusMethod,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ status }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        component,
        status,
        ok: false,
        statusCode: response.status,
        error: body || `instatus returned ${response.status}`,
      };
    }

    return { component, status, ok: true, statusCode: response.status };
  } catch (error) {
    return {
      component,
      status,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
