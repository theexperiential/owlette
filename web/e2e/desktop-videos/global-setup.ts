/**
 * Put the machine into the state the takes expect.
 *
 * Deliberately does NOT launch the app: each scene starts its own instance,
 * because the launch argv is part of what is being filmed (`--pair` opens the
 * pairing dialog at startup, which is the installer's real handoff). What has to
 * happen once, before any launch, is the state the host reads on the way up —
 * the layout file, and a scratch tree with the pairing/report-issue stub in it.
 *
 * Order is load-bearing: the layout is pinned before the first launch (the host
 * reads it once, in `setup`), and the scratch tree exists before that so the
 * first paint already shows fixture data.
 */

import { buildScratchRoot, snapshotLayout } from '../desktop-screenshots/harness';
import { CAPTURE_SIDEBAR, videoWindowSize } from './harness';
import { seedVideoStaticFiles } from './fixtures';

async function globalSetup(): Promise<void> {
  snapshotLayout(videoWindowSize(), CAPTURE_SIDEBAR);
  seedVideoStaticFiles(buildScratchRoot());
}

export default globalSetup;
