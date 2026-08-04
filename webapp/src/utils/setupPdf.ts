import { pdfjs } from 'react-pdf';

// Local worker bundled from the installed pdfjs-dist version — no CDN
// dependency (unpkg was blocked by CSP and a supply-chain risk anyway).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();
