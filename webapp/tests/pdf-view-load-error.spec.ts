import { expect, test } from '@playwright/test';

const SIGNER_URL = '/sign?doc=%2Fnonexistent.pdf';

// The checked-in local xiro-ui package is a no-op stub. Keep this browser test
// focused on the signer route and PDF error state by making the shell transparent.
const TRANSPARENT_XIRO_UI = `
  export const Button = ({ children }) => children;
  export const Modal = ({ children }) => children;
  export const Main = ({ children }) => children;
  export const Nav = ({ children }) => children;
`;

test('shows an error state when PDF document fails to load', async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.route('**/node_modules/.vite/deps/xiro-ui.js*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: TRANSPARENT_XIRO_UI,
    }),
  );
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
