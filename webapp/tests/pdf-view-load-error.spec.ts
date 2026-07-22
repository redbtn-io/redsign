import { expect, test } from '@playwright/test';

const SIGNER_URL = '/sign?doc=%2Fnonexistent.pdf';
const SIGNER_UPLOAD_URL = '/?e2eOpenSignatureDialog=1&e2eSetAdding=1';
const SAMPLE_PDF_BYTES = createSamplePdf();

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

test('supports redstyle signer dialog interactions without xiro-ui routing', async ({ page }) => {
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(SIGNER_UPLOAD_URL, { waitUntil: 'domcontentloaded' });

  await page.setInputFiles('#file-upload', {
    name: 'sample.pdf',
    mimeType: 'application/pdf',
    buffer: SAMPLE_PDF_BYTES,
  });

  await expect(page.getByText('PDF Preview:')).toBeVisible();
  await page.waitForLoadState('networkidle');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const signatureField = page.getByTestId('signature-field');
  await expect(signatureField).toHaveCount(0);

  const dialogContent = dialog.locator('div').first();
  const clipMetrics = await dialogContent.evaluate((element) => {
    const node = element as HTMLElement;
    return { clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
  });
  expect(clipMetrics.scrollWidth).toBeLessThanOrEqual(clipMetrics.clientWidth + 2);

  const fieldsBefore = await signatureField.count();
  const dialogRect = (await dialog.boundingBox())!;
  await page.mouse.click(dialogRect.x + 24, dialogRect.y + 24);
  await expect(signatureField).toHaveCount(fieldsBefore);

  await page.mouse.click(10, 10);
  await expect(dialog).not.toBeVisible();
});

function createSamplePdf(): Buffer {
  const stream = "BT /F1 24 Tf 100 700 Td (Hello redsign) Tj ET\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n",
    "2 0 obj\n<< /Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n",
    "3 0 obj\n<< /Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 595 842]\n/Resources << /Font << /F1 4 0 R >> >>\n/Contents 5 0 R\n>>\nendobj\n",
    "4 0 obj\n<< /Type /Font\n/Subtype /Type1\n/BaseFont /Helvetica\n>>\nendobj\n",
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`
  ];

  let rawPdf = '%PDF-1.4\n%±±\n';
  const offsets: number[] = [];

  for (const object of objects) {
    offsets.push(rawPdf.length);
    rawPdf += object;
  }

  const xrefOffset = rawPdf.length;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (const objectOffset of offsets) {
    xref += `${objectOffset.toString().padStart(10, '0')} 00000 n \n`;
  }

  rawPdf += xref;
  rawPdf += 'trailer\n';
  rawPdf += '<< /Size 6 /Root 1 0 R >>\n';
  rawPdf += `startxref\n${xrefOffset}\n`;
  rawPdf += '%%EOF\n';

  return Buffer.from(rawPdf);
}
