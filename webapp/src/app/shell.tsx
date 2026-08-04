"use client";

// The app shell + breakpoint tracking, ported verbatim from the Vite-era
// App.tsx (react-router removed — Next owns routing now).
import { AppShell } from "@redbtn/redstyle";
import { useEffect, useState } from "react";
import { Breakpoint } from "../types/breakpoint";

export function useBreakpoint(): Breakpoint | null {
  const [breakpoint, setBreakpoint] = useState<Breakpoint | null>(null);

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      if (width < 640) setBreakpoint("sm");
      else if (width < 768) setBreakpoint("md");
      else if (width < 1024) setBreakpoint("lg");
      else if (width < 1280) setBreakpoint("xl");
      else setBreakpoint("2xl");
    };
    handleResize(); // Set initial breakpoint
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return breakpoint;
}

export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <AppShell.Header sticky={false} className="border-b border-border bg-bg-elevated px-4 py-3 shadow-sm">
        <span className="text-base font-semibold text-text-primary">Redsign</span>
      </AppShell.Header>
      <AppShell.Content scroll={false} className="p-4">
        {children}
      </AppShell.Content>
    </AppShell>
  );
}
