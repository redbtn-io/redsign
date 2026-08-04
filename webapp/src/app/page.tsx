"use client";

import dynamic from "next/dynamic";
import Shell, { useBreakpoint } from "./shell";

// pdfjs touches browser globals — client-only, never server-rendered.
const PDFUploader = dynamic(() => import("../views/PDFUploader"), { ssr: false });

export default function UploaderRoute() {
  const breakpoint = useBreakpoint();
  return (
    <Shell>
      <PDFUploader breakpoint={breakpoint} />
    </Shell>
  );
}
