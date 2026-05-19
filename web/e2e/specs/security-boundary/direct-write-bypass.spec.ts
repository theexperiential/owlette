import { expect, test } from '@playwright/test';
import admin from 'firebase-admin';
import { type FirebaseApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  doc,
  getFirestore,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  assertDevProject,
  createAdminApp,
  createSignedInClient,
  errorCode,
  errorMessage,
  loadLocalEnv,
  makeRunIds,
  resolveProjectId,
  type CheckResult,
  writeReport,
} from './helpers';

async function expectPermissionDenied(
  name: string,
  operation: () => Promise<unknown>,
  checks: CheckResult[],
): Promise<void> {
  try {
    await operation();
    checks.push({
      name,
      ok: false,
      message: 'operation unexpectedly succeeded',
    });
    expect(`${name} unexpectedly succeeded`).toBe('');
  } catch (err) {
    const code = errorCode(err);
    const denied = code === 'permission-denied';
    checks.push({
      name,
      ok: denied,
      code,
      message: denied ? undefined : errorMessage(err),
    });
    expect(code).toBe('permission-denied');
  }
}

test('live dev rejects direct browser control-plane writes post-lockdown', async () => {
  loadLocalEnv();

  const projectId = resolveProjectId();
  assertDevProject(projectId);
  const ids = makeRunIds('w8');
  const adminApp = createAdminApp(projectId, `security-boundary-admin-${ids.runId}`);
  const adminAuth = adminApp.auth();
  const adminDb = adminApp.firestore();

  let clientApp: FirebaseApp | undefined;
  let signOutAndDelete: (() => Promise<void>) | undefined;
  const checks: CheckResult[] = [];

  try {
    await adminDb.collection('sites').doc(ids.siteId).set({
      name: 'W8.1 Security Boundary',
      owner: 'security-boundary-owner',
      timezone: 'UTC',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await adminDb.collection('users').doc(ids.uid).set({
      email: ids.email,
      role: 'member',
      sites: [ids.siteId],
      displayName: 'W8.1 Boundary User',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      mfaEnrolled: false,
      requiresMfaSetup: false,
    });
    await adminDb
      .collection('sites')
      .doc(ids.siteId)
      .collection('machines')
      .doc(ids.machineId)
      .set({
        online: true,
        lastHeartbeat: Math.floor(Date.now() / 1000),
        configChangeFlag: false,
        cortexEnabled: true,
      });
    await adminDb
      .collection('config')
      .doc(ids.siteId)
      .collection('machines')
      .doc(ids.machineId)
      .set({ processes: [] });

    const signedIn = await createSignedInClient(
      adminAuth,
      projectId,
      ids.uid,
      `security-boundary-client-${ids.runId}`,
    );
    clientApp = signedIn.app;
    signOutAndDelete = signedIn.signOutAndDelete;
    expect(getAuth(clientApp).currentUser?.uid).toBe(ids.uid);

    const clientDb = getFirestore(clientApp);

    await setDoc(doc(clientDb, 'users', ids.uid, 'settings', 'security-boundary-smoke'), {
      provider: 'none',
      updatedAt: Date.now(),
    });
    checks.push({ name: 'preference write remains allowed', ok: true });

    await expectPermissionDenied(
      'deployment create direct write denied',
      () =>
        setDoc(doc(clientDb, 'sites', ids.siteId, 'deployments', 'direct-deployment'), {
          name: 'Direct Deployment',
          installer_name: 'TouchDesigner.exe',
          targets: [ids.machineId],
          status: 'pending',
          createdAt: Date.now(),
        }),
      checks,
    );

    await expectPermissionDenied(
      'machine cortex toggle direct write denied',
      () =>
        updateDoc(doc(clientDb, 'sites', ids.siteId, 'machines', ids.machineId), {
          cortexEnabled: false,
        }),
      checks,
    );

    await expectPermissionDenied(
      'pending command direct write denied',
      () =>
        setDoc(
          doc(clientDb, 'sites', ids.siteId, 'machines', ids.machineId, 'commands', 'pending'),
          {
            'cmd-direct': {
              type: 'restart_process',
              status: 'pending',
              createdAt: Date.now(),
            },
          },
          { merge: true },
        ),
      checks,
    );

    await expectPermissionDenied(
      'machine config direct write denied',
      () =>
        setDoc(
          doc(clientDb, 'config', ids.siteId, 'machines', ids.machineId),
          {
            processes: [
              {
                id: 'proc-direct',
                name: 'TouchDesigner',
                path: 'C:\\TouchDesigner\\TouchDesigner.exe',
              },
            ],
          },
          { merge: true },
        ),
      checks,
    );
  } finally {
    writeReport(
      'direct-write-bypass',
      'W8.1 Direct Browser Write Bypass',
      {
        generatedAt: new Date().toISOString(),
        projectId,
        siteId: ids.siteId,
        machineId: ids.machineId,
        uid: ids.uid,
      },
      checks,
    );

    await Promise.allSettled([
      adminDb.collection('users').doc(ids.uid).collection('settings').doc('security-boundary-smoke').delete(),
      adminDb
        .collection('sites')
        .doc(ids.siteId)
        .collection('machines')
        .doc(ids.machineId)
        .collection('commands')
        .doc('pending')
        .delete(),
      adminDb.collection('sites').doc(ids.siteId).collection('machines').doc(ids.machineId).delete(),
      adminDb.collection('config').doc(ids.siteId).collection('machines').doc(ids.machineId).delete(),
      adminDb.collection('users').doc(ids.uid).delete(),
      adminDb.collection('sites').doc(ids.siteId).delete(),
      adminAuth.deleteUser(ids.uid),
    ]);

    await signOutAndDelete?.();
    await adminApp.delete();
  }
});
