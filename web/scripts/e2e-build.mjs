import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nextBin = path.join(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const authEmulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const storageEmulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
const distDir = process.env.OWLETTE_NEXT_DIST_DIR || '.next-e2e';

const e2eEnv = {
  NEXT_PUBLIC_USE_FIREBASE_EMULATOR: 'true',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-playwright-e2e',
  NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-api-key',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-playwright-e2e.firebaseapp.com',
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'demo-playwright-e2e.firebasestorage.app',
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
  NEXT_PUBLIC_FIREBASE_APP_ID: 'demo-app-id',
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: authEmulatorHost,
  NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: firestoreEmulatorHost,
  NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST: storageEmulatorHost,
  NEXT_PUBLIC_SENTRY_DSN: '',
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: 'e2e',
  OWLETTE_NEXT_DIST_DIR: distDir,
};

const productionBuildArtifacts = [
  'BUILD_ID',
  'app-build-manifest.json',
  'app-path-routes-manifest.json',
  'build',
  'build-manifest.json',
  'diagnostics',
  'export-marker.json',
  'fallback-build-manifest.json',
  'images-manifest.json',
  'lock',
  'node_modules',
  'package.json',
  'prerender-manifest.json',
  'required-server-files.json',
  'routes-manifest.json',
  'server',
  'static',
  'trace',
  'turbopack',
  'types',
];

async function runNextBuild() {
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [nextBin, 'build'],
      {
        cwd: appRoot,
        env: { ...process.env, ...e2eEnv },
        stdio: 'inherit',
      },
    );

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`next build failed with ${signal || `exit code ${code}`}`));
    });
  });
}

if (distDir === '.next') {
  for (const artifact of productionBuildArtifacts) {
    await fs.rm(path.join(appRoot, distDir, artifact), { recursive: true, force: true });
  }
} else {
  await fs.rm(path.resolve(appRoot, distDir), { recursive: true, force: true });
}

await runNextBuild();
