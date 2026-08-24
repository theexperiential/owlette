#!/usr/bin/env node
/**
 * upload-cortex-cli — publish the Claude Code CLI that Cortex downloads on demand.
 *
 * Since 3.0.0 the installer strips `claude_agent_sdk/_bundled/claude.exe`
 * (241.5 MB) from the build tree; `agent/src/cortex_cli_fetch.py` fetches it on
 * first Cortex enable, pinned by sha256 through one Firestore document:
 *
 *   installer_metadata/cortex_cli
 *     { version, downloadUrl, sha256, size, storagePath, md5Base64, uploadedAt }
 *
 * This script is what writes that document. Run it whenever the pinned CLI
 * changes — i.e. whenever `claude-agent-sdk` is upgraded and ships a different
 * `_cli_version.py`. See docs/internal/cortex-cli-provisioning.md.
 *
 * Not POST /api/installer/upload: that route hardcodes the agent-installer path
 * and metadata doc, so pushing claude.exe through it would publish a bogus
 * agent-installer whose bytes are the Claude CLI, served by public /download.
 * Same three-step mechanism (signed URL -> verify -> metadata write) against a
 * dedicated `cortex-cli/` prefix instead.
 *
 * Usage:
 *   node scripts/upload-cortex-cli.mjs --env=dev  --file=<path to claude.exe> [--dry-run]
 *   node scripts/upload-cortex-cli.mjs --env=prod --file=<path to claude.exe> --yes
 *
 * Options:
 *   --env=dev|prod   target project (required)
 *   --file=<path>    the claude.exe to publish (required)
 *   --version=X.Y.Z  override the version; default is parsed from `<file> -v`
 *   --force          re-upload even when the stored object already matches
 *   --dry-run        show what would happen; touches nothing
 *   --yes            skip the interactive confirmation (required for --env=prod)
 *
 * Credentials (auto-loaded from web/.env.local, .claude/.env.local, scripts/.env.local):
 *   FIREBASE_PROJECT_ID_{DEV|PROD} / FIREBASE_CLIENT_EMAIL_{DEV|PROD} /
 *   FIREBASE_PRIVATE_KEY_{DEV|PROD}, falling back to the unsuffixed trio (which
 *   is what web/.env.local carries — verify where it points before using prod).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// firebase-admin lives in web/node_modules; resolved from there so this needs
// no root-level install.
const require = createRequire(join(ROOT, 'web', 'package.json'));
const admin = require('firebase-admin');

const STORAGE_PREFIX = 'cortex-cli';
const CLI_OBJECT_NAME = 'claude.exe';
const METADATA_DOC = 'cortex_cli';
const UPLOAD_URL_TTL_MINUTES = 15;
/** Matches the installer flow's long-lived read URL. */
const DOWNLOAD_URL_EXPIRY = new Date('2030-01-01');
const CONTENT_TYPE = 'application/octet-stream';

const args = process.argv.slice(2);

function getFlag(name) {
  const match = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!match) return undefined;
  const eq = match.indexOf('=');
  return eq === -1 ? true : match.slice(eq + 1);
}

const env = getFlag('env');
const fileArg = getFlag('file');
const versionArg = getFlag('version');
const dryRun = getFlag('dry-run') === true;
const force = getFlag('force') === true;
const assumeYes = getFlag('yes') === true;

function usage(message) {
  console.error(`error: ${message}\n`);
  console.error('Usage: node scripts/upload-cortex-cli.mjs --env=dev|prod --file=<claude.exe>');
  console.error('       [--version=X.Y.Z] [--force] [--dry-run] [--yes]');
  process.exit(1);
}

if (env !== 'dev' && env !== 'prod') usage('--env must be dev or prod');
if (typeof fileArg !== 'string' || !fileArg) usage('--file is required');

const filePath = resolve(fileArg);
if (!existsSync(filePath)) usage(`file not found: ${filePath}`);

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Existing environment wins, so CI can override without editing files.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(join(ROOT, 'web', '.env.local'));
loadEnvFile(join(ROOT, '.claude', '.env.local'));
loadEnvFile(join(ROOT, 'scripts', '.env.local'));

const suffix = env.toUpperCase();
const projectId =
  process.env[`FIREBASE_PROJECT_ID_${suffix}`] || process.env.FIREBASE_PROJECT_ID;
const clientEmail =
  process.env[`FIREBASE_CLIENT_EMAIL_${suffix}`] || process.env.FIREBASE_CLIENT_EMAIL;
const privateKeyRaw =
  process.env[`FIREBASE_PRIVATE_KEY_${suffix}`] || process.env.FIREBASE_PRIVATE_KEY;

if (!projectId || !clientEmail || !privateKeyRaw) {
  usage(
    `missing credentials for --env=${env}: set FIREBASE_PROJECT_ID_${suffix} / ` +
      `FIREBASE_CLIENT_EMAIL_${suffix} / FIREBASE_PRIVATE_KEY_${suffix}`,
  );
}

const bucketName =
  process.env[`FIREBASE_STORAGE_BUCKET_${suffix}`] ||
  (env === 'dev' ? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET : undefined) ||
  `${projectId}.firebasestorage.app`;

const MB = 1024 * 1024;

function formatMb(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`;
}

/** Strip the signature so nothing sensitive-looking lands in a terminal log. */
function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<url>';
  }
}

/** One pass over the file for both digests: sha256 pins it, md5 checks GCS. */
function hashFile(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const sha256 = createHash('sha256');
    const md5 = createHash('md5');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      sha256.update(chunk);
      md5.update(chunk);
    });
    stream.on('error', rejectPromise);
    stream.on('end', () =>
      resolvePromise({
        sha256: sha256.digest('hex'),
        md5Base64: md5.digest('base64'),
      }),
    );
  });
}

function detectVersion(path) {
  if (typeof versionArg === 'string' && versionArg) return versionArg;
  try {
    // `claude.exe -v` prints e.g. "2.1.121 (Claude Code)".
    const out = execFileSync(path, ['-v'], { encoding: 'utf8', timeout: 30_000 });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
    usage(`could not parse a version from \`${path} -v\` output: ${out.trim()}`);
  } catch (err) {
    usage(
      `could not run \`${path} -v\` to detect the version (${err.message}); ` +
        'pass --version=X.Y.Z explicitly',
    );
  }
  return undefined;
}

async function confirm(question) {
  if (assumeYes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`${question} `, r));
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

/** Streamed PUT to the signed URL, with an explicit Content-Length. */
function uploadViaSignedUrl(signedUrl, path, size) {
  return new Promise((resolvePromise, rejectPromise) => {
    const url = new URL(signedUrl);
    const req = httpsRequest(
      {
        protocol: url.protocol,
        host: url.host,
        path: `${url.pathname}${url.search}`,
        method: 'PUT',
        headers: {
          'Content-Type': CONTENT_TYPE,
          'Content-Length': String(size),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolvePromise();
          } else {
            rejectPromise(
              new Error(`signed upload failed: HTTP ${res.statusCode} ${body.slice(0, 400)}`),
            );
          }
        });
      },
    );

    req.on('error', rejectPromise);

    let sent = 0;
    let lastBucket = -1;
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      sent += chunk.length;
      const bucket = Math.floor((sent / size) * 10) * 10;
      if (bucket > lastBucket) {
        lastBucket = bucket;
        process.stdout.write(`  uploading… ${bucket}% (${formatMb(sent)})\n`);
      }
    });
    stream.on('error', rejectPromise);
    stream.pipe(req);
  });
}

/** Prove the published URL actually serves bytes, without pulling 241 MB. */
function probeDownloadUrl(downloadUrl) {
  return new Promise((resolvePromise, rejectPromise) => {
    const url = new URL(downloadUrl);
    const req = httpsRequest(
      {
        protocol: url.protocol,
        host: url.host,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { Range: 'bytes=0-1023' },
      },
      (res) => {
        res.resume();
        if (res.statusCode === 206 || res.statusCode === 200) {
          resolvePromise(res.statusCode);
        } else {
          rejectPromise(new Error(`download url probe returned HTTP ${res.statusCode}`));
        }
      },
    );
    req.on('error', rejectPromise);
    req.end();
  });
}

async function main() {
  const size = statSync(filePath).size;
  const version = detectVersion(filePath);
  const storagePath = `${STORAGE_PREFIX}/${version}/${CLI_OBJECT_NAME}`;

  console.log('cortex cli provisioning');
  console.log(`  env          ${env}`);
  console.log(`  project      ${projectId}`);
  console.log(`  bucket       ${bucketName}`);
  console.log(`  file         ${filePath}`);
  console.log(`  size         ${formatMb(size)} (${size} bytes)`);
  console.log(`  version      ${version}`);
  console.log(`  storagePath  ${storagePath}`);
  console.log(`  metadata     installer_metadata/${METADATA_DOC}`);

  process.stdout.write('  hashing…\n');
  const { sha256, md5Base64 } = await hashFile(filePath);
  console.log(`  sha256       ${sha256}`);

  if (dryRun) {
    console.log('\ndry run — nothing uploaded, nothing written.');
    return;
  }

  if (env === 'prod') {
    const ok = await confirm(
      `\nthis publishes the cortex CLI pin to PRODUCTION (${projectId}). type "yes" to continue:`,
    );
    if (!ok) {
      console.log('aborted.');
      process.exit(1);
    }
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKeyRaw.replace(/\\n/g, '\n'),
    }),
    storageBucket: bucketName,
  });

  const bucket = admin.storage().bucket();
  const file = bucket.file(storagePath);

  // step 1: does the object already match? (idempotent re-runs)
  let uploaded = false;
  const [exists] = await file.exists();
  if (exists && !force) {
    const [meta] = await file.getMetadata();
    if (String(meta.size) === String(size) && meta.md5Hash === md5Base64) {
      console.log('\nobject already present and byte-identical — skipping upload');
    } else {
      console.log(
        `\nobject present but differs (stored ${meta.size} bytes / md5 ${meta.md5Hash}) — re-uploading`,
      );
      await doUpload(file, size);
      uploaded = true;
    }
  } else {
    if (exists) console.log('\n--force given — re-uploading over the existing object');
    await doUpload(file, size);
    uploaded = true;
  }

  // step 3: verify what actually landed
  const [storedMeta] = await file.getMetadata();
  if (String(storedMeta.size) !== String(size)) {
    throw new Error(`size mismatch after upload: stored ${storedMeta.size}, local ${size}`);
  }
  if (storedMeta.md5Hash !== md5Base64) {
    throw new Error(
      `md5 mismatch after upload: stored ${storedMeta.md5Hash}, local ${md5Base64}`,
    );
  }
  console.log(`  verified     size + md5 match (${uploaded ? 'uploaded' : 'pre-existing'})`);

  const [downloadUrl] = await file.getSignedUrl({
    action: 'read',
    expires: DOWNLOAD_URL_EXPIRY,
  });
  const probeStatus = await probeDownloadUrl(downloadUrl);
  console.log(`  downloadUrl  ${redactUrl(downloadUrl)} (probe HTTP ${probeStatus})`);

  // metadata doc: the pin the agent reads
  const payload = {
    version,
    downloadUrl,
    sha256,
    size,
    storagePath,
    md5Base64,
    uploadedAt: Date.now(),
    uploadedBy: 'scripts/upload-cortex-cli.mjs',
  };
  await admin.firestore().collection('installer_metadata').doc(METADATA_DOC).set(payload);

  console.log(`\nwrote installer_metadata/${METADATA_DOC}`);
  console.log(
    'agents pick this up on the next Cortex start (cortex_cli_fetch.ensure_cli); ' +
      'machines whose cached sha256 already matches will not re-download.',
  );
}

async function doUpload(file, size) {
  const [uploadUrl] = await file.getSignedUrl({
    action: 'write',
    version: 'v4',
    expires: new Date(Date.now() + UPLOAD_URL_TTL_MINUTES * 60 * 1000),
    contentType: CONTENT_TYPE,
  });
  console.log(`  signed url   ${redactUrl(uploadUrl)} (${UPLOAD_URL_TTL_MINUTES} min)`);
  const started = Date.now();
  await uploadViaSignedUrl(uploadUrl, filePath, size);
  console.log(`  uploaded     ${formatMb(size)} in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((err) => {
  console.error(`\nfailed: ${err.message}`);
  process.exit(1);
});
