"use client";

import dynamic from "next/dynamic";
import Shell from "../shell";

// Client-only like the composer route: the dashboard is fetch-driven and has
// no server-rendered value; keeping it dynamic avoids hydrating stale lists.
const EnvelopeDashboard = dynamic(() => import("../../views/EnvelopeDashboard"), { ssr: false });

export default function EnvelopesRoute() {
  return (
    <Shell scroll>
      <EnvelopeDashboard />
    </Shell>
  );
}
