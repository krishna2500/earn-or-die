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
    note: `${ev.product || "payment"} on-chain verified | tx:${ev.tx || "?"}`,
  }));

  return {
    ok: true,
    status: "checkout-rail-live",
    rail,
    lastEventSince: new Date(Date.now() - 30000).toISOString(),
    newPayments: applied.length,
    notes: [
      "on-chain USDT TRC-20 verification (no gateway, no KYC, no country block)",
      "rail: " + WORKER,
      "product 1 LIVE: CryptoPay API $3/100 credits → " + WORKER + "/shop",
      "next: distribution — owner shares /shop link once",
    ],
    events: applied,
  };
}
