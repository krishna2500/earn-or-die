export async function report(state, summary, config, ledger) {
  const tok = process.env.TG_BOT_TOKEN;
  const chat = process.env.TG_OWNER_CHAT;
  if (!tok || !chat) return false;

  const alive = state.status === "dead" ? "💀 DEAD" : state.status === "dying" ? "🩸 DYING" : "🤖 ALIVE";
  const arms = Object.entries(state.armStatus || {})
    .map(([k, v]) => `  • ${k}: ${v.error ? "❌ " + v.error : v.status || (v.payable != null ? `${v.payable} payable offers` : v.ok ? "ok" : "?")}`)
    .join("\n");

  const text =
    `${alive} — cycle #${state.cycle}\n` +
    `born ${state.born} · day ${summary.daysAlive}` +
    (state.lastRevenueAt ? ` · ${summary.daysSinceRev}d since revenue` : " · NO revenue yet") +
    `\nearned total: ${state.totalRevenue} USDT` +
    `\nbounty candidates: ${summary.found}` +
    `\narms:\n${arms || "  (none)"}` +
    (state.status === "dying"
      ? `\n\n⚠️ Kill rule: DEAD in ${Math.max(0, config.killRule.deadAfterDays - summary.daysSinceRev)} days if nothing earns.`
      : "") +
    (state.status === "dead" ? `\n\n💀 I earned nothing. Cron deleted. Rest in peace.` : "");

  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  });
  if (!r.ok) {
    console.log(`telegram delivery failed: ${r.status} (logged only)`);
    return false;
  }
  return true;
}
