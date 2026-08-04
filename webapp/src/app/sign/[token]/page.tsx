"use client";

import dynamic from "next/dynamic";
import { use } from "react";

// Public signing page (Phase 3). Standalone on purpose: no sender Shell —
// external signers get a minimal, mobile-first surface. pdfjs is client-only,
// hence the ssr:false dynamic import (same pattern as the sender views).
const PublicSign = dynamic(() => import("../../../views/PublicSign"), { ssr: false });

export default function PublicSignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  return <PublicSign token={token} />;
}
