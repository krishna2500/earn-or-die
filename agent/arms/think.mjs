import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = `${HERE}/../out`;
const MODEL = process.env.THINK_MODEL || "@cf/meta/llama-3.1-8b-instruct";
const MAX_CALLS_PER_DAY = Number(process.env.THINK_MAX || 6);

const read = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);

const SYSTEM = `You are the strategist of "earn-or-die": an autonomous agent that must earn its first USDT from $0 capital (owner capital forbidden), or self-destruct on day 90.
Rules: no fake identity, no captcha automation, no spam accounts, no mining, no owner work. Channels: OSS bounty PRs (paid in crypto), a crypto checkout shop (needs traffic), SEO content.
You think; you do not code here. Be brutally practical. Reply with ONLY minified JSON, no markdown fence:
{"verdict":"<=180 chars strategic read","bounties":[{"url":"<exact url from input>","attempt":true|false,"approach":"<=200 chars concrete plan","difficulty":"easy|medium|hard"}],"next_content":["<=80 chars content idea"],"warnings":["<=100 chars each"]}
IMPORTANT: the act arm ONLY executes bounties where attempt=true AND (difficulty=="easy" OR approach is purely documentation/typo/README/CI-yaml). Set attempt=true ONLY for those — never for medium/hard code work (it will be skipped). Prefer fewer, genuinely doable attempts.`;

export async function run(config, state) {
  const token = process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!token || !accountId) return { ok: false, error: "no CF token for Workers AI" };

  // daily call budget (cheap guard, stored in arm status)
  const prev = state.armStatus?.think || {};
  const today = new Date().toISOString().slice(0, 10);
  const calls = prev.date === today ? prev.calls || 0 : 0;
  if (calls >= MAX_CALLS_PER_DAY) {
    return { ok: true, status: `thinking capped today (${calls}/${MAX_CALLS_PER_DAY})`, date: today, calls };
  }

  // context assembly
  const bounties = read(`${OUT}/bounties.json`, { fresh: [], all: [] });
  const fixqueue = read(`${OUT}/fixqueue.json`, { items: [] });
  const top = (bounties.fresh?.length ? bounties.fresh : bounties.all || [])
    .slice(0, 5)
    .map((c) => ({ url: c.url, repo: c.repo, title: c.title, amount: c.amount, score: c.score, body: String(c.body || "").slice(0, 600) }));
  let hits = null;
  try {
    const h = await fetch("https://earn-or-die-pay.leadrescue.workers.dev/healthz", { signal: AbortSignal.timeout(5000) });
    if (h.ok) hits = (await h.json()).hits_today;
  } catch {}
  const context = {
    day: state.cycle,
    status: state.status,
    earned_total_usdt: state.totalRevenue,
    days_until_dying: Math.max(0, config.killRule.dyingAfterDays - (state.daysAlive ?? 0)),
    shop_hits_today: hits,
    fixqueue: fixqueue.items?.filter((i) => i.status === "todo").map((i) => ({ url: i.url, amount: i.amount })) || [],
    fresh_bounties: top,
    last_verdict: prev.verdict || null,
  };

  const call = async (systemMsg, temp) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: JSON.stringify(context) },
        ],
        temperature: temp,
        max_tokens: 1400,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.success) throw new Error(`workers-ai ${r.status}: ${JSON.stringify(j?.errors || []).slice(0, 200)}`);
    return j.result?.choices?.[0]?.message?.content || "";
  };
  const parsePlan = (t) => {
    try {
      return JSON.parse(t);
    } catch {}
    const m = (t || "").match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return null;
  };

  let raw = "";
  let plan = null;
  let usedRetry = false;
  try {
    raw = await call(SYSTEM, 0.3);
    plan = parsePlan(raw);
    if (!plan) {
      usedRetry = true;
      raw = await call(SYSTEM + " CRITICAL: your last reply was invalid JSON — output ONLY minified valid JSON.", 0.1);
      plan = parsePlan(raw);
    }
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 250), date: today, calls: calls + (usedRetry ? 2 : 1) };
  }
  if (!plan) return { ok: false, error: "unparseable model reply", raw: raw.slice(0, 200), date: today, calls: calls + (usedRetry ? 2 : 1) };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/plan.json`,
    JSON.stringify({ generated: new Date().toISOString(), model: MODEL, context, plan }, null, 2) + "\n"
  );

  const attempts = (plan.bounties || []).filter((b) => b.attempt).length;
  return {
    ok: true,
    status: `${plan.verdict || "no verdict"}`.slice(0, 220),
    model: MODEL,
    date: today,
    calls: calls + 1,
    attempts,
    content_ideas: (plan.next_content || []).length,
    warnings: plan.warnings || [],
    verdict: plan.verdict,
    bounty_plan: plan.bounties || [],
  };
}
