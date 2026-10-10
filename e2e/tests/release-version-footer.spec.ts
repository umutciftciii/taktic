import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Actor } from '../src/actors';
import { createAdmin } from '../src/fixtures';
import { primaryRuntime } from '../src/runtime';

/**
 * RELEASE-BASELINE-001 — the production builds this suite runs carry the root
 * package.json version into the admin and web footers. The expected value is
 * read from that file here, never written: bumping the root version is the
 * only change that moves it.
 */

const rootVersion = (JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string })
  .version;

test.describe('RELEASE-BASELINE-001 — the build version in the footers', () => {
  test('admin and web show "Taktick v<root version>" and no commit id', async ({ browser }) => {
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const account = await createAdmin();
    const actor = await Actor.open(browser, 'staff', primaryRuntime);
    try {
      await actor.loginToAdmin(account.email, account.password);
      await actor.gotoAdmin('/offers');
      const adminVersion = actor.page.locator('footer.admin-footer').getByTestId('app-version');
      await expect(adminVersion).toHaveText(`Taktick v${rootVersion}`);

      await actor.gotoWeb('/');
      const webVersion = actor.page.locator('footer').getByTestId('app-version');
      await expect(webVersion).toHaveText(`Taktick v${rootVersion}`);
    } finally {
      await actor.close();
    }
  });
});
