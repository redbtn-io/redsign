import { expect, test } from '@playwright/test';

const SIGNER_URL = '/sign?doc=%2Fnonexistent.pdf';

test('shows an error state when PDF document fails to load', async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(SIGNER_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
  });

  const errorAlert = page.getByRole('alert');
  await expect(errorAlert).toBeVisible();
  await expect(errorAlert).toHaveText(/Unable to load the PDF document\./);
});
