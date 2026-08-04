"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  LoadingSpinner,
} from "@redbtn/redstyle";
import { useCallback, useEffect, useState } from "react";

// Sender dashboard (Phase 4): every envelope with live status, per-signer
// progress, signing-link recovery, void, download, and the lifecycle timeline
// from envelope_events. Mobile-first: 390px is the primary layout — cards
// stack, nothing needs horizontal scrolling.

type Signer = {
  idx: number;
  name: string;
  email?: string;
  status: string;
  viewedAt?: string | null;
  signedAt?: string | null;
};

type Envelope = {
  _id: string;
  status: string;
  documentName: string;
  createdAt: string;
  completedAt?: string | null;
  voidedAt?: string | null;
  executedFileId?: string | null;
  signers: Signer[];
};

type LinkRow = { idx: number; name: string; status: string; signingUrl: string };
type EventRow = { event: string; signerIdx: number | null; at: string };

const STATUS_VARIANT: Record<string, "default" | "success" | "warning" | "error" | "info" | "secondary"> = {
  draft: "secondary",
  sent: "info",
  completed: "success",
  declined: "warning",
  voided: "error",
};

function fmt(d: string | null | undefined): string {
  if (!d) return "";
  const date = new Date(d);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function progressLabel(signers: Signer[]): string {
  const signed = signers.filter((s) => s.status === "signed").length;
  return `${signed}/${signers.length} signed`;
}

async function copyText(url: string) {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Clipboard API can be unavailable (permissions, http) — legacy fallback.
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
}

function EventTimeline({ events }: { events: EventRow[] }) {
  if (!events.length) return null;
  return (
    <div data-testid="events-timeline">
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Activity</p>
      <ol className="space-y-1">
        {events.map((ev, i) => (
          <li key={i} data-testid="event-item" className="flex items-baseline gap-2 text-sm">
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-accent" />
            <span className="font-medium capitalize text-text-primary">{ev.event}</span>
            {ev.signerIdx != null && <span className="text-text-secondary">signer {ev.signerIdx + 1}</span>}
            <span className="ml-auto shrink-0 text-xs text-text-secondary">{fmt(ev.at)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function EnvelopeDetail({
  envelope,
  onVoided,
}: {
  envelope: Envelope;
  onVoided: () => void;
}) {
  const [links, setLinks] = useState<LinkRow[] | null>(null);
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const voidable = envelope.status === "sent" || envelope.status === "draft";

  useEffect(() => {
    let dead = false;
    (async () => {
      const [linksRes, eventsRes] = await Promise.all([
        // Links exist only for recoverable (non-voided) envelopes; a 4xx here
        // just means no copyable links, which the UI already conveys.
        voidable ? fetch(`/api/envelopes/${envelope._id}/links`) : null,
        fetch(`/api/envelopes/${envelope._id}/events`),
      ]);
      if (dead) return;
      if (linksRes?.ok) setLinks((await linksRes.json()).signers ?? []);
      if (eventsRes?.ok) setEvents((await eventsRes.json()).events ?? []);
    })().catch(() => {});
    return () => {
      dead = true;
    };
  }, [envelope._id, envelope.status, voidable]);

  async function copyLink(idx: number) {
    const url = links?.find((l) => l.idx === idx)?.signingUrl;
    if (!url) return;
    await copyText(url);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1500);
  }

  async function doVoid() {
    setVoiding(true);
    setError(null);
    try {
      const res = await fetch(`/api/envelopes/${envelope._id}/void`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setConfirmVoid(false);
      onVoided();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVoiding(false);
    }
  }

  return (
    <div className="space-y-4 border-t border-border pt-3" data-testid="envelope-detail">
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Signers</p>
        <ul className="space-y-2">
          {envelope.signers.map((s) => (
            <li key={s.idx} data-testid="signer-row" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium text-text-primary">{s.name}</span>
              <Badge variant={s.status === "signed" ? "success" : "default"}>{s.status}</Badge>
              <span className="text-xs text-text-secondary">
                {s.status === "signed"
                  ? `signed ${fmt(s.signedAt)}`
                  : s.viewedAt
                    ? `viewed ${fmt(s.viewedAt)}`
                    : "not viewed yet"}
              </span>
              {s.status === "pending" && voidable && links && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  data-testid="copy-signing-link"
                  onClick={() => copyLink(s.idx)}
                >
                  {copiedIdx === s.idx ? "Copied" : "Copy link"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>

      {events ? <EventTimeline events={events} /> : <LoadingSpinner size="sm" />}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid="envelope-download"
          onClick={() => window.open(`/api/envelopes/${envelope._id}/document`, "_blank")}
        >
          {envelope.executedFileId ? "Download executed PDF" : "Download original PDF"}
        </Button>
        {voidable && (
          <Button size="sm" variant="destructive" data-testid="void-button" onClick={() => setConfirmVoid(true)}>
            Void
          </Button>
        )}
        {error && <span className="text-sm text-error">{error}</span>}
      </div>

      <Dialog open={confirmVoid} onOpenChange={setConfirmVoid}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void this envelope?</DialogTitle>
            <DialogDescription>
              “{envelope.documentName}” will be cancelled. Signing links stop working immediately and
              this cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmVoid(false)} disabled={voiding}>
              Keep it
            </Button>
            <Button variant="destructive" data-testid="void-confirm" onClick={doVoid} disabled={voiding}>
              {voiding ? "Voiding…" : "Void envelope"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function EnvelopeDashboard() {
  const [envelopes, setEnvelopes] = useState<Envelope[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/envelopes");
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
      setEnvelopes((await res.json()).envelopes ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-text-primary">Envelopes</h1>
        <Button size="sm" variant="ghost" onClick={load}>
          Refresh
        </Button>
      </div>

      {error && (
        <p className="mb-4 text-sm text-error" data-testid="dashboard-error">
          {error}
        </p>
      )}
      {!envelopes && !error && <LoadingSpinner label="Loading envelopes" />}
      {envelopes?.length === 0 && (
        <p className="text-sm text-text-secondary" data-testid="dashboard-empty">
          No envelopes yet — compose one to get started.
        </p>
      )}

      <div className="space-y-3">
        {envelopes?.map((e) => (
          // redstyle Card doesn't forward data-* attributes — the testid
          // lives on a plain wrapper div instead.
          <div key={e._id} data-testid="envelope-row">
            <Card>
              <CardContent className="p-4">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left"
                  data-testid="envelope-toggle"
                  onClick={() => setOpenId(openId === e._id ? null : e._id)}
                >
                  <span className="min-w-0 flex-1 basis-40 truncate font-medium text-text-primary">
                    {e.documentName}
                  </span>
                  <span className="text-xs text-text-secondary" data-testid="envelope-progress">
                    {progressLabel(e.signers)}
                  </span>
                  <span data-testid="envelope-status">
                    <Badge variant={STATUS_VARIANT[e.status] ?? "default"}>{e.status}</Badge>
                  </span>
                  <span className="w-full text-xs text-text-secondary sm:w-auto">
                    created {fmt(e.createdAt)}
                  </span>
                </button>
                {openId === e._id && (
                  <div className="mt-3">
                    <EnvelopeDetail envelope={e} onVoided={load} />
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
}
