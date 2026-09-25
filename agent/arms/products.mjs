const WORKER = process.env.PAY_WORKER || "https://earn-or-die-pay.leadrescue.workers.dev";

export async function run(config, state) {
  const prev = state.armStatus?.products || {};
  const since = prev.lastEventSince || new Date(0).toISOString();
  let events = [];
  let rail = "unknown";

  try {
    const r = await fetch(`${WORKER}/events?since=${encodeURIComponent(since)}`, {
      headers: { accept: "application/json" },
    });
    if (r.ok) {
      const j = await r.json();
      events = Array.isArray(j.events) ? j.events : [];
      rail = "live";
    }
  } catch (e) {
    return {
      ok: false,
      status: "checkout-rail-unreachable",
      error: String(e?.message || e).slice(0, 200),
      notes: ["rail: " + WORKER],
    };
  }

  const applied = events.map((ev) => ({
    ts: ev.ts,
    amount: Number(ev.amount),
    currency: ev.currency || "USDT",
    note: ev.note || `on-chain payment ${ev.tx || ""}`,
  }));

  return {
    ok: true,
    status: "checkout-rail-live",
    rail,
    lastEventSince: new Date().toISOString(),
    newPayments: applied.length,
    notes: [
      "on-chain USDT TRC-20 verification (no gateway, no KYC, no country block)",
      "rail: " + WORKER,
      "first product: still building — rail is ready before storefront",
    ],
    events: applied,
  };
}
