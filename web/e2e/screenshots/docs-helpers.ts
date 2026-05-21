import { mkdir } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS } from './fixtures';

const DOCS_SCREENSHOT_DIR = 'public/docs-screens';

export async function pinAdminSiteContext(siteId: string): Promise<void> {
  await getAdminDb()
    .collection('users')
    .doc(TEST_USERS.admin.uid)
    .set(
      {
        sites: [siteId],
        lastSiteId: siteId,
        preferences: {
          statsExpanded: true,
          processesExpanded: true,
          displaysExpanded: true,
          activeGraphPanel: null,
          timeDisplayMode: 'site',
          timeFormat: '12h',
          timezone: 'America/Los_Angeles',
        },
      },
      { merge: true },
    );
}

export async function installFixedClock(page: Page): Promise<void> {
  await page.clock.install({ time: FIXED_NOW_MS });
}

export async function disableAnimations(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `,
  });
}

export async function settleForDocsScreenshot(page: Page): Promise<void> {
  await page.waitForTimeout(1500);
  await disableAnimations(page);
  await page.clock.setFixedTime(FIXED_NOW_MS);
  await page.waitForTimeout(500);
}

export async function saveDocsScreenshot(
  target: Locator,
  filename: string,
): Promise<void> {
  await mkdir(DOCS_SCREENSHOT_DIR, { recursive: true });
  await expect(target).toBeVisible();
  await target.screenshot({
    path: `${DOCS_SCREENSHOT_DIR}/${filename}`,
  });
}
