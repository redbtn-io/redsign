"use client";

import dynamic from "next/dynamic";
import Shell, { useBreakpoint } from "../shell";

// Sender-side signer view (reads ?doc= from the query, exactly as the
// prototype did). Public token signing pages land at /sign/[token] in
// Phase 3; this bare route stays authed.
const PDFSigner = dynamic(() => import("../../views/PDFSigner"), { ssr: false });

export default function SignerRoute() {
  const breakpoint = useBreakpoint();
  return (
    <Shell>
      <PDFSigner breakpoint={breakpoint} />
    </Shell>
  );
}
