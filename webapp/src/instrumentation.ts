// Webhook delivery sweep: no external queue/cron infra. Every 60s the server
// claims due `webhook_deliveries` rows (atomic findOneAndUpdate — replicas or
// restarts never double-send a claimed row) and retries them with backoff
// (30s / 2m / 10m, 5 attempts — lib/webhooksig.ts). Same in-process pattern
// redFinance uses for its daily compliance tick.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.MONGODB_URI) return;
  const { sweepDueDeliveries } = await import("./lib/webhooks");
  setInterval(async () => {
    try {
      const n = await sweepDueDeliveries();
      if (n) console.log(`[webhooks] sweep attempted ${n} due deliver${n === 1 ? "y" : "ies"}`);
    } catch (e) {
      console.error("[webhooks] sweep failed:", e);
    }
  }, 60_000);
}
