import { expect, test } from '@playwright/test';

const SIGNER_URL = 'http://127.0.0.1:5173/sign?doc=%2Fnonexistent.pdf';

test('shows an error state when PDF document fails to load', async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(SIGNER_URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.body.getBoundingClientRect().width > 0);
  const errorAlert = page.getByRole('alert');
  await expect(errorAlert).toBeVisible();
  await expect(errorAlert).toHaveText(/Unable to load the PDF document/);
  await expect(errorAlert).toContainText(/Unable to load this PDF document/i);
});

