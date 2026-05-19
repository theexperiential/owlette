/**
 * Webhook signature verification workflow.
 *
 * Pipe a raw webhook body into stdin and set OWLETTE_SIGNATURE plus
 * OWLETTE_WEBHOOK_SECRET to verify a real delivery. With no signature env,
 * the script signs the body first so the fixture can run locally.
 *
 * Required for real deliveries:
 *   OWLETTE_WEBHOOK_SECRET or ROOST_WEBHOOK_SECRET
 *   OWLETTE_SIGNATURE or ROOST_SIGNATURE
 */

import { signBody, verifySignature } from '@owlette/sdk';

async function readStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<number> {
  const raw = await readStdin();
  const body = raw.length > 0
    ? raw
    : Buffer.from('{"event":"version.published","roostId":"rst_example"}');
  const secret =
    process.env.OWLETTE_WEBHOOK_SECRET ??
    process.env.ROOST_WEBHOOK_SECRET ??
    'whsec_dev_fixture_do_not_use';
  let signature = process.env.OWLETTE_SIGNATURE ?? process.env.ROOST_SIGNATURE;

  if (!signature) {
    signature = signBody(body, secret);
    console.log('generated fixture signature');
  }

  const toleranceRaw = process.env.OWLETTE_TOLERANCE_SECONDS;
  const toleranceSeconds = toleranceRaw ? Number(toleranceRaw) : undefined;
  const result = verifySignature(
    signature,
    body,
    secret,
    toleranceSeconds === undefined ? {} : { toleranceSeconds },
  );

  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

main().then((code) => process.exit(code));
