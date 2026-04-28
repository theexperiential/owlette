import crypto from 'crypto';
import {
  FieldValue,
  Timestamp,
  type CollectionReference,
  type DocumentData,
} from 'firebase-admin/firestore';
import { getAdminDb } from './emulator';
import { seedMachine, seedUser, type TestUser } from './seed';

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

async function clearCollection(col: CollectionReference<DocumentData>): Promise<void> {
  const refs = await col.listDocuments();
  await Promise.all(refs.map((ref) => ref.delete()));
}

export async function deleteDocIfExists(path: string): Promise<void> {
  await getAdminDb().doc(path).delete();
}

export async function clearSiteLogs(siteId = 'site-A'): Promise<void> {
  await clearCollection(getAdminDb().collection('sites').doc(siteId).collection('logs'));
}

export interface SeedLogEvent {
  id: string;
  action: string;
  level: 'info' | 'warning' | 'error';
  machineId: string;
  machineName?: string;
  processName?: string;
  details?: string;
  timestamp?: Date;
  screenshotUrl?: string;
  userId?: string;
}

export async function seedLogEvents(
  siteId = 'site-A',
  events: SeedLogEvent[] = defaultLogEvents(),
): Promise<string[]> {
  await clearSiteLogs(siteId);
  const col = getAdminDb().collection('sites').doc(siteId).collection('logs');
  await Promise.all(
    events.map((event) =>
      col.doc(event.id).set({
        action: event.action,
        level: event.level,
        machineId: event.machineId,
        machineName: event.machineName ?? event.machineId,
        ...(event.processName ? { processName: event.processName } : {}),
        ...(event.details ? { details: event.details } : {}),
        ...(event.screenshotUrl ? { screenshotUrl: event.screenshotUrl } : {}),
        ...(event.userId ? { userId: event.userId } : {}),
        timestamp: Timestamp.fromDate(event.timestamp ?? new Date()),
      }),
    ),
  );
  return events.map((event) => event.id);
}

function defaultLogEvents(): SeedLogEvent[] {
  const now = Date.now();
  return [
    {
      id: 'e2e-log-crash',
      action: 'process_crash',
      level: 'error',
      machineId: 'e2e-logs-machine',
      machineName: 'e2e-logs-machine',
      processName: 'TouchDesigner',
      details: 'TouchDesigner crashed with exit code 1',
      screenshotUrl: PNG_1X1,
      timestamp: new Date(now - 60_000),
      userId: 'admin-uid',
    },
    {
      id: 'e2e-log-warning',
      action: 'deployment_failed',
      level: 'warning',
      machineId: 'e2e-logs-machine',
      machineName: 'e2e-logs-machine',
      processName: 'Installer',
      details: 'Installer returned retryable warning',
      timestamp: new Date(now - 120_000),
    },
    {
      id: 'e2e-log-info',
      action: 'agent_started',
      level: 'info',
      machineId: 'e2e-logs-alt',
      machineName: 'e2e-logs-alt',
      details: 'Agent started normally',
      timestamp: new Date(now - 180_000),
    },
  ];
}

export async function seedScreenshotFixture(
  siteId = 'site-A',
  machineId = 'e2e-screen-machine',
): Promise<void> {
  await seedMachine(siteId, machineId, { displayName: machineId });
  const machineRef = getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  await machineRef.set(
    {
      lastScreenshot: {
        url: PNG_1X1,
        capturedAt: Timestamp.fromDate(new Date()),
      },
    },
    { merge: true },
  );
  await machineRef.collection('screenshots').doc('e2e-screenshot-1').set({
    url: PNG_1X1,
    capturedAt: Timestamp.fromDate(new Date(Date.now() - 30_000)),
    width: 1,
    height: 1,
  });
}

export async function seedLiveViewFixture(
  siteId = 'site-A',
  machineId = 'e2e-live-machine',
): Promise<void> {
  await seedScreenshotFixture(siteId, machineId);
  await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        liveView: {
          active: true,
          intervalSeconds: 10,
          expiresAt: Math.floor(Date.now() / 1000) + 600,
        },
      },
      { merge: true },
    );
}

export async function clearCortexFixture(userId: string, siteId = 'site-A'): Promise<void> {
  const db = getAdminDb();
  await db.collection('users').doc(userId).collection('settings').doc('llm').delete();
  await db.collection('sites').doc(siteId).collection('settings').doc('llm').delete();
  await Promise.all([
    db.collection('chats').doc(`e2e-cortex-user-${userId}`).delete(),
    db.collection('chats').doc(`e2e-cortex-auto-${siteId}`).delete(),
  ]);
}

export async function seedCortexFixture(opts: {
  userId: string;
  siteId?: string;
  machineId?: string;
  hasUserKey?: boolean;
}): Promise<void> {
  const siteId = opts.siteId ?? 'site-A';
  const machineId = opts.machineId ?? 'e2e-cortex-machine';
  const db = getAdminDb();
  await seedMachine(siteId, machineId, { displayName: machineId });
  await seedMachine(siteId, 'e2e-cortex-offline', {
    displayName: 'e2e-cortex-offline',
    heartbeatOffsetSec: 600,
  });
  if (opts.hasUserKey ?? true) {
    await db.collection('users').doc(opts.userId).collection('settings').doc('llm').set({
      provider: 'openai',
      model: 'gpt-test',
      hasKey: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  const now = new Date();
  await db.collection('chats').doc(`e2e-cortex-user-${opts.userId}`).set({
    userId: opts.userId,
    siteId,
    title: 'Deployment triage',
    category: 'Operations',
    targetType: 'machine',
    targetMachineId: machineId,
    machineName: machineId,
    source: 'user',
    messages: [
      {
        id: 'm-user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Why did deployment fail?' }],
      },
      {
        id: 'm-assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'The installer exited with a retryable warning.' },
          {
            type: 'tool-checkLogs',
            toolCallId: 'tool-1',
            state: 'output-available',
            args: { machineId },
            output: { status: 'warning' },
          },
        ],
      },
    ],
    createdAt: Timestamp.fromDate(new Date(now.getTime() - 120_000)),
    updatedAt: Timestamp.fromDate(new Date(now.getTime() - 60_000)),
  });
  await db.collection('chats').doc(`e2e-cortex-auto-${siteId}`).set({
    siteId,
    title: 'Nightly auto investigation',
    category: 'Autonomous',
    targetType: 'site',
    targetMachineId: null,
    machineName: 'All Machines',
    source: 'autonomous',
    autonomousSummary: 'Autonomous check found no active incident.',
    messages: [
      {
        id: 'm-auto-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Autonomous check found no active incident.' }],
      },
    ],
    createdAt: Timestamp.fromDate(new Date(now.getTime() - 240_000)),
    updatedAt: Timestamp.fromDate(new Date(now.getTime() - 180_000)),
  });
}

export async function seedCliDeviceCode(
  code = 'silver-compass-drift',
  deviceCode = 'e2e-device-code-secret',
): Promise<string> {
  const deviceCodeHash = crypto.createHash('sha256').update(deviceCode).digest('hex');
  await getAdminDb().collection('cli_device_codes').doc(code).set({
    deviceCodeHash,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
    authorizedBy: null,
    authorizedAt: null,
    siteId: null,
    keyId: null,
    rawKey: null,
  });
  return deviceCode;
}

export async function seedSystemPreset(
  presetId = 'e2e-system-preset',
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await getAdminDb().collection('system_presets').doc(presetId).set({
    name: 'E2E Template 1.0',
    software_name: 'E2E Template',
    category: 'Utilities',
    description: 'Seeded by coverageSeed.ts',
    installer_name: 'e2e-template.exe',
    installer_url: 'https://example.test/e2e-template.exe',
    silent_flags: '/S',
    verify_path: 'C:\\Program Files\\E2E\\template.exe',
    timeout_seconds: 600,
    order: 10,
    is_owlette_agent: false,
    createdBy: 'e2e-seed',
    createdAt: Timestamp.fromDate(new Date(Date.now() - 60_000)),
    updatedAt: Timestamp.fromDate(new Date(Date.now() - 30_000)),
    ...overrides,
  });
}

export async function clearSystemPreset(presetId = 'e2e-system-preset'): Promise<void> {
  await getAdminDb().collection('system_presets').doc(presetId).delete();
}

export async function seedInstallerLatest(
  downloadUrl = 'https://example.test/downloads/owlette-e2e.exe',
): Promise<void> {
  await getAdminDb().collection('installer_metadata').doc('latest').set({
    version: 'e2e-latest',
    download_url: downloadUrl,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export function dedicatedUser(role: TestUser['role'], suffix = Date.now().toString()): TestUser {
  return {
    uid: `e2e-${role}-${suffix}`,
    email: `e2e-${role}-${suffix}@example.test`,
    password: `e2e-${role}-${suffix}-password`,
    role,
    sites: ['site-A'],
    displayName: `E2E ${role} ${suffix}`,
  };
}

export async function seedDedicatedUser(user: TestUser): Promise<TestUser> {
  await seedUser(user);
  return user;
}

export const SAMPLE_SCREENSHOT_DATA_URL = PNG_1X1;
