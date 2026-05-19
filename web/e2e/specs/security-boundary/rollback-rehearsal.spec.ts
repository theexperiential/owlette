import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import admin from 'firebase-admin';
import { doc, getFirestore, setDoc } from 'firebase/firestore';
import {
  assertDevProject,
  createAdminApp,
  createSignedInClient,
  errorCode,
  errorMessage,
  loadLocalEnv,
  makeRunIds,
  pushCheck,
  REPORT_DIR,
  resolveBaseUrl,
  resolveProjectId,
  type CheckResult,
  writeReport,
} from './helpers';

type ApiResult = {
  status: number;
  body: unknown;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  durationMs: number;
};

const execFileAsync = promisify(execFile);
const WEB_ROOT = process.cwd();
const REPO_ROOT = resolve(WEB_ROOT, '..');
const LOCKED_RULES_REF = 'd94122b:firestore.rules';
const PERMISSIVE_RULES_REF = 'd94122b^:firestore.rules';

test.skip(
  process.env.SECURITY_BOUNDARY_RUN_ROLLBACK_REHEARSAL !== '1',
  'set SECURITY_BOUNDARY_RUN_ROLLBACK_REHEARSAL=1 to deploy rules during the W8.1 rollback drill',
);

function firebaseBinary(): string {
  return process.platform === 'win32' ? 'firebase.cmd' : 'firebase';
}

async function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  const started = Date.now();
  const executable = process.platform === 'win32' && command.endsWith('.cmd')
    ? 'cmd.exe'
    : command;
  const finalArgs = executable === 'cmd.exe'
    ? ['/d', '/s', '/c', command, ...args]
    : args;
  try {
    const { stdout, stderr } = await execFileAsync(executable, finalArgs, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      stdout,
      stderr,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const failed = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    throw new Error(
      [
        `${command} ${args.join(' ')} failed`,
        failed.message ?? '',
        failed.stdout ?? '',
        failed.stderr ?? '',
      ].filter(Boolean).join('\n'),
    );
  }
}

async function gitShow(ref: string): Promise<string> {
  const result = await runCommand('git', ['show', ref], REPO_ROOT);
  return result.stdout;
}

async function deployRules(
  runId: string,
  projectId: string,
  label: string,
  rulesContent: string,
): Promise<CommandResult> {
  const dir = join(REPORT_DIR, 'rules-rollback', runId, label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'firestore.rules'), rulesContent, 'utf8');
  writeFileSync(
    join(dir, 'firebase.json'),
    `${JSON.stringify({ firestore: { rules: 'firestore.rules' } }, null, 2)}\n`,
    'utf8',
  );

  return runCommand(
    firebaseBinary(),
    [
      'deploy',
      '--only',
      'firestore:rules',
      '--project',
      projectId,
      '--config',
      'firebase.json',
      '--non-interactive',
    ],
    dir,
  );
}

async function apiCall(
  request: APIRequestContext,
  baseUrl: string,
  idToken: string,
  method: 'POST',
  path: string,
  body: unknown,
): Promise<ApiResult> {
  const response = await request.fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `w8-${randomUUID()}`,
    },
    data: body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status(), body: parsed };
}

function checkStatus(
  checks: CheckResult[],
  name: string,
  result: ApiResult,
  expected: number,
): void {
  const body = result.body && typeof result.body === 'object'
    ? (result.body as Record<string, unknown>)
    : {};
  const code = typeof body.code === 'string'
    ? body.code
    : typeof body.title === 'string'
      ? body.title
      : undefined;
  const ok = result.status === expected;
  pushCheck(checks, {
    name,
    ok,
    status: result.status,
    code,
    message: ok ? undefined : JSON.stringify(result.body),
  });
  expect(result.status, `${name}: ${JSON.stringify(result.body)}`).toBe(expected);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function attemptDirectDeploymentWrite(
  app: Parameters<typeof getFirestore>[0],
  siteId: string,
  suffix: string,
): Promise<{ ok: boolean; code?: string; message?: string }> {
  const clientDb = getFirestore(app);
  try {
    await setDoc(doc(clientDb, 'sites', siteId, 'deployments', `rollback-${suffix}`), {
      name: `Rollback Drill ${suffix}`,
      installer_name: 'rollback.exe',
      targets: [],
      status: 'pending',
      createdAt: Date.now(),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: errorCode(err), message: errorMessage(err) };
  }
}

async function waitForDirectWriteOutcome(
  app: Parameters<typeof getFirestore>[0],
  siteId: string,
  suffix: string,
  expected: 'allow' | 'deny',
): Promise<{ ok: boolean; code?: string; message?: string }> {
  let last: { ok: boolean; code?: string; message?: string } | undefined;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    last = await attemptDirectDeploymentWrite(app, siteId, `${suffix}-${attempt}`);
    if (expected === 'allow' && last.ok) return last;
    if (expected === 'deny' && !last.ok && last.code === 'permission-denied') return last;
    await sleep(1_000);
  }
  return last ?? { ok: false, message: 'no direct write attempt result' };
}

async function seedUser(
  auth: admin.auth.Auth,
  db: admin.firestore.Firestore,
  uid: string,
  email: string,
  role: 'member' | 'admin' | 'superadmin',
  sites: string[],
): Promise<void> {
  await auth.createUser({
    uid,
    email,
    emailVerified: true,
    displayName: `W8 Rollback ${role}`,
  }).catch(async (err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
      await auth.updateUser(uid, { email, emailVerified: true });
      return;
    }
    throw err;
  });

  await db.collection('users').doc(uid).set({
    email,
    role,
    sites,
    displayName: `W8 Rollback ${role}`,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    mfaEnrolled: false,
    requiresMfaSetup: false,
  });
}

async function seedRollbackData(
  db: admin.firestore.Firestore,
  auth: admin.auth.Auth,
  ids: ReturnType<typeof makeRunIds>,
): Promise<{ memberUid: string; superUid: string; memberEmail: string; superEmail: string }> {
  const memberUid = `${ids.uid}-member`;
  const superUid = `${ids.uid}-super`;
  const memberEmail = `${memberUid}@security-boundary.e2e`;
  const superEmail = `${superUid}@security-boundary.e2e`;

  await db.collection('sites').doc(ids.siteId).set({
    name: 'W8.1 Rollback Rehearsal',
    owner: ids.uid,
    timezone: 'UTC',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await db
    .collection('sites')
    .doc(ids.siteId)
    .collection('machines')
    .doc(ids.machineId)
    .set({
      online: true,
      lastHeartbeat: Math.floor(Date.now() / 1000),
      cortexEnabled: true,
      metrics: { processes: { 'TouchDesigner.exe': { status: 'running' } } },
    });
  await db
    .collection('config')
    .doc(ids.siteId)
    .collection('machines')
    .doc(ids.machineId)
    .set({ processes: [] });

  await seedUser(auth, db, ids.uid, ids.email, 'admin', [ids.siteId]);
  await seedUser(auth, db, memberUid, memberEmail, 'member', [ids.siteId]);
  await seedUser(auth, db, superUid, superEmail, 'superadmin', []);

  return { memberUid, superUid, memberEmail, superEmail };
}

async function hasCapabilityBypassAudit(
  db: admin.firestore.Firestore,
  siteId: string,
  memberUid: string,
): Promise<boolean> {
  const snap = await db
    .collection('sites')
    .doc(siteId)
    .collection('audit_log')
    .where('enforcementBypassed', '==', true)
    .get();

  return snap.docs.some((entry) => {
    const data = entry.data();
    const actor = data.actor as Record<string, unknown> | undefined;
    const metadata = data.metadata as Record<string, unknown> | undefined;
    return (
      actor?.type === 'user' &&
      actor.userId === memberUid &&
      data.outcome === 'allow' &&
      metadata?.enforcement_bypassed === 'capability'
    );
  });
}

test('live dev rollback rehearsal flips kill switch and restores locked rules', async ({ request }) => {
  loadLocalEnv();

  const projectId = resolveProjectId();
  assertDevProject(projectId);
  const baseUrl = resolveBaseUrl();
  const ids = makeRunIds('w8-rollback');
  const adminApp = createAdminApp(projectId, `security-boundary-rollback-admin-${ids.runId}`);
  const adminAuth = adminApp.auth();
  const adminDb = adminApp.firestore();
  const checks: CheckResult[] = [];
  const deployTimings: Record<string, number> = {};
  let lockedRules = '';
  let permissiveRules = '';
  let adminClient: Awaited<ReturnType<typeof createSignedInClient>> | undefined;
  let memberClient: Awaited<ReturnType<typeof createSignedInClient>> | undefined;
  let superClient: Awaited<ReturnType<typeof createSignedInClient>> | undefined;

  try {
    lockedRules = await gitShow(LOCKED_RULES_REF);
    permissiveRules = await gitShow(PERMISSIVE_RULES_REF);

    const seeded = await seedRollbackData(adminDb, adminAuth, ids);
    adminClient = await createSignedInClient(
      adminAuth,
      projectId,
      ids.uid,
      `security-boundary-rollback-client-admin-${ids.runId}`,
    );
    memberClient = await createSignedInClient(
      adminAuth,
      projectId,
      seeded.memberUid,
      `security-boundary-rollback-client-member-${ids.runId}`,
    );
    superClient = await createSignedInClient(
      adminAuth,
      projectId,
      seeded.superUid,
      `security-boundary-rollback-client-super-${ids.runId}`,
    );

    const lockedDeploy = await deployRules(ids.runId, projectId, 'locked-start', lockedRules);
    deployTimings.lockedStartMs = lockedDeploy.durationMs;
    pushCheck(checks, { name: 'locked rules deploy at rehearsal start', ok: true });

    await adminDb.collection('global').doc('security_config').set(
      {
        capability_enforcement: true,
        rate_limit_enforcement: true,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    await sleep(6_500);

    const memberDenied = await apiCall(
      request,
      baseUrl,
      memberClient.idToken,
      'POST',
      `/api/sites/${ids.siteId}/machines/${ids.machineId}/commands`,
      { type: 'restart_process', params: { process_name: 'TouchDesigner.exe' } },
    );
    checkStatus(checks, 'member command denied before kill switch', memberDenied, 403);

    const flipOff = await apiCall(
      request,
      baseUrl,
      superClient.idToken,
      'POST',
      '/api/platform/security/kill-switch',
      {
        flag: 'capability_enforcement',
        enabled: false,
        reason: `W8.1 rollback rehearsal ${ids.runId}`,
        expiresInMinutes: 5,
      },
    );
    checkStatus(checks, 'capability kill switch disabled by superadmin', flipOff, 200);
    await sleep(6_500);

    const memberAllowed = await apiCall(
      request,
      baseUrl,
      memberClient.idToken,
      'POST',
      `/api/sites/${ids.siteId}/machines/${ids.machineId}/commands`,
      { type: 'restart_process', params: { process_name: 'TouchDesigner.exe' } },
    );
    checkStatus(checks, 'member command allowed while capability switch off', memberAllowed, 202);

    const bypassAuditSeen = await hasCapabilityBypassAudit(adminDb, ids.siteId, seeded.memberUid);
    pushCheck(checks, {
      name: 'capability bypass audit recorded',
      ok: bypassAuditSeen,
      message: bypassAuditSeen ? undefined : 'no matching enforcementBypassed audit row found',
    });
    expect(bypassAuditSeen).toBe(true);

    const flipOn = await apiCall(
      request,
      baseUrl,
      superClient.idToken,
      'POST',
      '/api/platform/security/kill-switch',
      {
        flag: 'capability_enforcement',
        enabled: true,
        reason: `W8.1 rollback rehearsal restore ${ids.runId}`,
        expiresInMinutes: 5,
      },
    );
    checkStatus(checks, 'capability kill switch re-enabled by superadmin', flipOn, 200);
    await sleep(6_500);

    const memberDeniedRestored = await apiCall(
      request,
      baseUrl,
      memberClient.idToken,
      'POST',
      `/api/sites/${ids.siteId}/machines/${ids.machineId}/commands`,
      { type: 'restart_process', params: { process_name: 'TouchDesigner.exe' } },
    );
    checkStatus(checks, 'member command denied after kill switch restore', memberDeniedRestored, 403);

    const permissiveDeploy = await deployRules(ids.runId, projectId, 'permissive', permissiveRules);
    deployTimings.permissiveMs = permissiveDeploy.durationMs;
    pushCheck(checks, { name: 'permissive rules rollback deploy', ok: true });

    const directAllowed = await waitForDirectWriteOutcome(
      adminClient.app,
      ids.siteId,
      'permissive',
      'allow',
    );
    pushCheck(checks, {
      name: 'direct browser control-plane write allowed under permissive rules',
      ok: directAllowed.ok,
      code: directAllowed.code,
      message: directAllowed.message,
    });
    expect(directAllowed.ok, directAllowed.message).toBe(true);
  } finally {
    await adminDb.collection('global').doc('security_config').set(
      {
        capability_enforcement: true,
        rate_limit_enforcement: true,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    ).catch((err: unknown) => {
      pushCheck(checks, {
        name: 'security config force-enable cleanup',
        ok: false,
        message: errorMessage(err),
      });
    });

    if (lockedRules) {
      try {
        const restoreDeploy = await deployRules(ids.runId, projectId, 'locked-restore', lockedRules);
        deployTimings.lockedRestoreMs = restoreDeploy.durationMs;
        pushCheck(checks, { name: 'locked rules restored after rollback drill', ok: true });

        if (adminClient) {
          const directDenied = await waitForDirectWriteOutcome(
            adminClient.app,
            ids.siteId,
            'locked',
            'deny',
          );
          pushCheck(checks, {
            name: 'direct browser control-plane write denied after rules restore',
            ok: !directDenied.ok && directDenied.code === 'permission-denied',
            code: directDenied.code,
            message: directDenied.message,
          });
        }
      } catch (err) {
        pushCheck(checks, {
          name: 'locked rules restored after rollback drill',
          ok: false,
          message: errorMessage(err),
        });
      }
    }

    writeReport(
      'rollback-rehearsal',
      'W8.1 Rollback Rehearsal',
      {
        generatedAt: new Date().toISOString(),
        projectId,
        baseUrl,
        siteId: ids.siteId,
        uid: ids.uid,
        lockedStartDeployMs: deployTimings.lockedStartMs ?? '',
        permissiveDeployMs: deployTimings.permissiveMs ?? '',
        lockedRestoreDeployMs: deployTimings.lockedRestoreMs ?? '',
      },
      checks,
    );

    await Promise.allSettled([
      adminClient?.signOutAndDelete(),
      memberClient?.signOutAndDelete(),
      superClient?.signOutAndDelete(),
      adminDb.recursiveDelete(adminDb.collection('sites').doc(ids.siteId)),
      adminDb.recursiveDelete(adminDb.collection('config').doc(ids.siteId)),
      adminDb.recursiveDelete(adminDb.collection('users').doc(ids.uid)),
      adminAuth.deleteUser(ids.uid),
      adminAuth.deleteUser(`${ids.uid}-member`),
      adminAuth.deleteUser(`${ids.uid}-super`),
    ]);
    await adminApp.delete();
  }
});
