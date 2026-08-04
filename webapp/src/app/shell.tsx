"use client";

// The app shell + breakpoint tracking, ported verbatim from the Vite-era
// App.tsx (react-router removed — Next owns routing now).
import { AppShell } from "@redbtn/redstyle";
import Link from "next/link";
import { usePathname } from "next/navigation";
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

const NAV = [
  { href: "/", label: "Compose", testid: "nav-compose" },
  { href: "/envelopes", label: "Envelopes", testid: "nav-envelopes" },
] as const;

export default function Shell({
  children,
  scroll = false,
}: {
  children: React.ReactNode;
  // The composer manages its own scrolling; document-style pages (the
  // envelope dashboard) want the shell content area to scroll instead.
  scroll?: boolean;
}) {
  const pathname = usePathname();
  return (
    <AppShell>
      <AppShell.Header sticky={false} className="border-b border-border bg-bg-elevated px-4 py-3 shadow-sm">
        <div className="flex items-center gap-5">
          <span className="text-base font-semibold text-text-primary">Redsign</span>
          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                data-testid={item.testid}
                className={`rounded-md px-2.5 py-1 text-sm transition-colors ${
                  pathname === item.href
                    ? "bg-bg-active font-medium text-text-primary"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </AppShell.Header>
      <AppShell.Content scroll={scroll} className="p-4">
        {children}
      </AppShell.Content>
    </AppShell>
  );
}
