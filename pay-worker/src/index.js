const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ORDER_TTL = 1800;
const MAX_PENDING = 60;
const SHOP = {
  "paykit-100": {
    price: 3,
    credits: 100,
    title: "CryptoPay API — 100 invoice credits",
    desc: "Accept USDT TRC-20 with no gateway, no KYC. Exact-amount invoices + on-chain auto-verify API. 100 credits, key valid forever until used.",
  },
  "paykit-300": {
    price: 8,
    credits: 300,
    title: "CryptoPay API — 300 invoice credits",
    desc: "Same rail, bigger pack. 300 invoice credits for $8 (save 11%). Key valid forever until used.",
  },
  "usdt-kit": {
    price: 5,
    digital: true,
    title: "USDT Integration Kit — full source",
    desc: "Complete worker + agent source: accept USDT TRC-20 with on-chain auto-verify (TronGrid), exact-amount invoices, Telegram alerts. Deploy on your own Cloudflare free tier in minutes.",
  },
  "scout-kit": {
    price: 4,
    digital: true,
    title: "OSS Bounty Scout — source pack",
    desc: "GitHub bounty finder source: Algora/Opire/generic search, spam/farm/zombie filters, freshness scoring, fix-queue output. Runs on Node 22 + GitHub Actions free tier.",
  },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

async function tg(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_OWNER_CHAT) return;
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_OWNER_CHAT, text }),
  }).catch(() => {});
}

async function activeAmount(env, amount) {
  return env.ORDERS.get(`amt:${amount}`);
}

async function makeOrder(env, product, price) {
  for (let i = 0; i < 30; i++) {
    const suffix = Math.floor(Math.random() * 9000) + 1000;
    const amount = (price + suffix / 1e6).toFixed(6);
    if (await activeAmount(env, amount)) continue;
    const id = crypto.randomUUID();
    const now = Date.now();
    const ttl = Number(env.ORDER_TTL_S) > 0 ? Number(env.ORDER_TTL_S) : ORDER_TTL;
    const order = { id, product, price, amount, created: now, expires: now + ttl * 1000, status: "pending" };
    await env.ORDERS.put(`order:${id}`, JSON.stringify(order), { expirationTtl: 86400 });
    await env.ORDERS.put(`amt:${amount}`, id, { expirationTtl: 86400 });
    return order;
  }
  return null;
}

// KV reads are edge-cached (~60s) so KV counters can't do tight rate limits.
// In-memory per-isolate buckets handle bursts; KV stays for durable state only.
const mem = new Map();
function memGet(k) {
  const e = mem.get(k);
  if (!e || e.exp < Date.now()) {
    mem.delete(k);
    return null;
  }
  return e.v;
}
function memSet(k, v, ms) {
  mem.set(k, { v, exp: Date.now() + ms });
  if (mem.size > 8000) {
    for (const key of mem.keys()) {
      mem.delete(key);
      if (mem.size <= 4000) break;
    }
  }
}
function ipSpend(ip, limit = 10) {
  if (!ip) return true;
  const k = `o:${ip}`;
  const b = memGet(k) || { n: 0 };
  if (b.n >= limit) return false;
  b.n += 1;
  memSet(k, b, 3600 * 1000);
  return true;
}

async function createOrder(env, body, ip) {
  const product = String(body?.product || "").trim();
  const fromShop = SHOP[product];
  const price = fromShop ? fromShop.price : Number(body?.price);
  if (!Number.isFinite(price) || price < 0.5 || price > 500) {
    return json({ error: "unknown product or price must be 0.5-500 USDT" }, 400);
  }
  const lim = Number(env.ORDER_RATE_LIMIT);
  if (!ipSpend(ip, lim > 0 ? lim : 10)) return json({ error: "rate-limited, retry later" }, 429);
  const order = await makeOrder(env, fromShop ? product : String(body?.product || "custom").slice(0, 80), price);
  if (!order) return json({ error: "no unique amount available, retry" }, 503);
  return json({
    order_id: order.id,
    pay_exact: order.amount,
    asset: env.ASSET,
    network: env.NETWORK,
    address: env.WALLET,
    expires_at: new Date(order.expires).toISOString(),
    how: `Send EXACTLY ${order.amount} ${env.ASSET} on ${env.NETWORK}. Auto-detected on-chain.`,
  });
}

async function getOrder(env, id) {
  const raw = await env.ORDERS.get(`order:${id}`);
  if (!raw) return json({ error: "not found" }, 404);
  const o = JSON.parse(raw);
  if (o.status === "pending" && Date.now() > o.expires) {
    o.status = "expired";
    await env.ORDERS.put(`order:${id}`, JSON.stringify(o), { expirationTtl: 86400 });
  }
  const out = { order_id: o.id, status: o.status, product: o.product, pay_exact: o.amount, paid_tx: o.tx || null };
  if (o.status === "paid" && o.access_key) out.access_key = o.access_key;
  if (o.status === "paid" && o.credits != null) out.credits = o.credits;
  return json(out);
}

async function getEvents(env, since) {
  const raw = (await env.ORDERS.get("events", { type: "json" })) || [];
  const t = since ? Date.parse(since) || 0 : 0;
  return json({ events: raw.filter((e) => Date.parse(e.ts) > t) });
}

async function provision(env, order) {
  const spec = SHOP[order.product];
  if (!spec) return;
  const key = `pk_live_${crypto.randomUUID().replaceAll("-", "")}`;
  order.access_key = key;
  const acct = { key, created: Date.now() };
  if (spec.credits) {
    order.credits = spec.credits;
    acct.credits = spec.credits;
  }
  if (spec.digital) acct.digital = order.product;
  await env.ORDERS.put(`key:${key}`, JSON.stringify(acct), { expirationTtl: 86400 * 365 });
}

async function getAsset(env, url) {
  const key = (url.searchParams.get("key") || "").trim();
  if (!key.startsWith("pk_live_")) return json({ error: "missing key" }, 401);
  const acct = await env.ORDERS.get(`key:${key}`, { type: "json" });
  if (!acct) return json({ error: "invalid key" }, 401);
  if (!acct.digital) return json({ error: "this key is not a digital product — use POST /v1/invoice" }, 400);
  const asset = await env.ORDERS.get(`asset:${acct.digital}`, { type: "json" });
  if (!asset) return json({ error: "asset not provisioned" }, 503);
  return json({ product: acct.digital, unlocked_at: new Date().toISOString(), ...asset });
}

async function useInvoice(env, request) {
  const auth = request.headers.get("authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "").trim();
  if (!key.startsWith("pk_live_")) return json({ error: "missing bearer key" }, 401);
  const raw = await env.ORDERS.get(`key:${key}`);
  if (!raw) return json({ error: "invalid key" }, 401);
  const acct = JSON.parse(raw);
  if (!(acct.credits >= 1)) return json({ error: "no credits left" }, 402);
  const body = await request.json().catch(() => null);
  const price = Number(body?.price);
  const product = String(body?.product || "item").slice(0, 80);
  if (!Number.isFinite(price) || price < 0.5 || price > 500) {
    return json({ error: "price must be 0.5-500 USDT" }, 400);
  }
  const order = await makeOrder(env, product, price);
  if (!order) return json({ error: "no unique amount available, retry" }, 503);
  acct.credits -= 1;
  await env.ORDERS.put(`key:${key}`, JSON.stringify(acct), { expirationTtl: 86400 * 365 });
  return json({
    order_id: order.id,
    pay_exact: order.amount,
    address: env.WALLET,
    network: env.NETWORK,
    asset: env.ASSET,
    expires_at: new Date(order.expires).toISOString(),
    credits_left: acct.credits,
  });
}

async function verify(env) {
  // ZERO list() calls — free tier is 1k lists/day and this runs every minute.
  // Matching goes through amt: (unique-amount index); a timestamp window skips history.
  const src = env.VERIFY_MOCK_URL || `https://api.trongrid.io/v1/accounts/${env.WALLET}/transactions/trc20?only_to=true&limit=50`;
  const r = await fetch(src, { headers: { accept: "application/json" } });
  if (!r.ok) {
    const n = Number((await env.ORDERS.get("meta:vg_fail")) || 0) + 1;
    await env.ORDERS.put("meta:vg_fail", String(n), { expirationTtl: 60 * 60 * 48 });
    if (n >= 10) await tg(env, `⚠️ verify fetch failing x${n} (${r.status}) — payments may go undetected`);
    return 0;
  }
  await env.ORDERS.put("meta:vg_fail", "0", { expirationTtl: 60 * 60 * 48 });
  const { data = [] } = await r.json();

  const lastTs = Number((await env.ORDERS.get("meta:last_tx_ts")) || 0);
  let paid = 0;
  let maxTs = lastTs;
  const bump = (t) => {
    if (t > maxTs) maxTs = t;
  };

  for (const tx of data) {
    const txTime = tx.block_timestamp || 0;
    // 1s back-skew so same-millisecond siblings are re-checked; seen: dedupes
    if (txTime && txTime < lastTs - 1000) continue;
    if (tx.token_info?.address && tx.token_info.address !== USDT_CONTRACT) continue;
    const value = Number(tx.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (await env.ORDERS.get(`seen:${tx.transaction_id}`)) continue;
    const amountStr = (value / 1e6).toFixed(6);

    const oid = await env.ORDERS.get(`amt:${amountStr}`);
    if (!oid) {
      bump(txTime);
      continue;
    }
    const oraw = await env.ORDERS.get(`order:${oid}`);
    if (!oraw) {
      bump(txTime);
      continue;
    }
    const o = JSON.parse(oraw);
    const late = o.status === "expired";
    if (o.status === "paid") {
      bump(txTime);
      continue;
    }
    if (o.created > txTime) {
      // tx predates this invoice — never credit; seen: stops re-checking it every minute
      await env.ORDERS.put(`seen:${tx.transaction_id}`, o.id, { expirationTtl: 86400 * 30 });
      bump(txTime);
      continue;
    }

    o.status = "paid";
    o.tx = tx.transaction_id;
    o.paidAt = new Date(txTime).toISOString();
    o.payer = tx.from;
    if (late) o.late = true;
    await provision(env, o);
    await env.ORDERS.put(`order:${o.id}`, JSON.stringify(o), { expirationTtl: 86400 * 30 });
    await env.ORDERS.put(`amt:${o.amount}`, o.id, { expirationTtl: 86400 * 30 });
    await env.ORDERS.put(`seen:${tx.transaction_id}`, o.id, { expirationTtl: 86400 * 30 });
    bump(txTime);

    const events = (await env.ORDERS.get("events", { type: "json" })) || [];
    events.push({
      ts: new Date().toISOString(),
      order_id: o.id,
      product: o.product,
      amount: o.price,
      currency: env.ASSET,
      tx: tx.transaction_id,
      note: `${o.product} on-chain verified${late ? " (late payment honored)" : ""}`,
    });
    while (events.length > 500) events.shift();
    await env.ORDERS.put("events", JSON.stringify(events));

    await tg(
      env,
      `💰 PAID ${o.price} ${env.ASSET} — ${o.product}${late ? " (late payment honored)" : ""}\ntx: ${tx.transaction_id}` +
        (o.access_key ? `\nkey: ${o.access_key}` : "")
    );
    paid++;
  }

  if (maxTs > lastTs) await env.ORDERS.put("meta:last_tx_ts", String(maxTs), { expirationTtl: 60 * 60 * 24 * 30 });
  return paid;
}

const INDEXNOW_KEY = "1530340e4319a39160b5bed310e8f7d6";

const page = (env, body, title = "EARN-OR-DIE", desc = "Earn from zero: USDT TRC-20 checkout with on-chain auto-verification — no gateway, no KYC.", path = "/") =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="${desc}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://earn-or-die-pay.leadrescue.workers.dev${path}">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="https://earn-or-die-pay.leadrescue.workers.dev${path}">
<title>${title}</title>
<style>
body{font-family:system-ui;background:#0b0f14;color:#d7f5e9;margin:0;padding:40px 20px}
main{max-width:640px;margin:auto}
h1{font-size:1.6rem}code,.amt{background:#132029;padding:2px 8px;border-radius:6px;user-select:all}
.card{border:1px solid #1e3a2f;border-radius:14px;padding:20px;margin:18px 0;background:#0e151c}
button{background:#16a34a;border:0;color:#fff;font-size:1rem;padding:12px 22px;border-radius:10px;cursor:pointer}
.muted{color:#6b8f7e;font-size:.9rem}#out{white-space:pre-wrap;font-family:ui-monospace,monospace}
</style><main>${body}</main>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );

const shopPage = (env) => {
  const ld = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: Object.entries(SHOP).map(([id, p], i) => ({
      "@type": "Product",
      position: i + 1,
      name: p.title,
      description: p.desc,
      url: `https://earn-or-die-pay.leadrescue.workers.dev/shop?product=${id}`,
      offers: { "@type": "Offer", price: p.price, priceCurrency: "USD", availability: "https://schema.org/InStock" },
    })),
  };
  return page(
    env,
    `<h1>🧾 CryptoPay Shop</h1>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<p class="muted">On-chain USDT TRC-20 verification — no gateway, no KYC, no country block. Money lands straight in your wallet.</p>
${Object.entries(SHOP)
  .map(
    ([id, p]) => `<div class="card">
<b>${p.title}</b>
<p>${p.desc}</p>
<p><span class="amt">$${p.price}</span> — ${p.credits ? `${p.credits} invoice credits · key valid forever` : "instant unlock after payment"}</p>
<button onclick="buy('${id}')">Buy now</button>
<div id="o_${id}" class="muted"></div>
</div>`
  )
  .join("\n")}
<p class="muted">payout: <code>${env.WALLET}</code> (${env.NETWORK})</p>
<script>
let oid=null,amt=null,timer=null,outEl=null;
async function buy(pid){
  outEl=document.getElementById('o_'+pid);
  outEl.textContent='creating order...';
  const r=await fetch('/order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({product:pid})});
  const j=await r.json();
  if(j.error){outEl.textContent=j.error;return}
  oid=j.order_id;
  outEl.textContent='PAY EXACTLY '+j.pay_exact+' USDT ('+j.network+')\\nto: '+j.address+'\\n\\nwaiting for on-chain confirmation...';
  clearInterval(timer);
  timer=setInterval(check,4000);
}
async function check(){
  if(!outEl)return;
  const r=await fetch('/order?id='+oid);
  const j=await r.json();
  if(j.status==='paid'){
    clearInterval(timer);
    let s='PAID ✓\\n\\nYOUR KEY:\\n'+(j.access_key||'')+'\\n';
    if(j.credits!=null)s+='\\ncredits: '+j.credits+'\\nEndpoint: POST /v1/invoice (Bearer key, body {product,price})';
    else s+='\\nDownload: /get?key='+j.access_key;
    outEl.textContent=s;
  } else if(j.status==='expired'){clearInterval(timer);outEl.textContent='order expired — buy again'}
}
</script>`,
    "CryptoPay Shop — accept USDT TRC-20, no gateway",
    "Buy API credits and digital kits with USDT TRC-20. On-chain verification, instant key delivery, no KYC.",
    "/shop"
  );
};

const statusPage = (env) =>
  page(
    env,
    `<h1>💰 EARN-OR-DIE — payment rail</h1>
<div class="card">status: <b style="color:#4ade80">LIVE</b> · on-chain verification (no gateway, no KYC)<br>
pay to: <code>${env.WALLET}</code> (${env.NETWORK} ${env.ASSET})<br>
<a style="color:#4ade80" href="/shop">→ shop</a><br>
<small class="muted">orders: POST /order · check GET /order?id= · events GET /events?since= · api POST /v1/invoice</small></div>`,
    "EARN-OR-DIE pay rail"
  );

async function ghRuns(env, workflowFile) {
  try {
    const r = await fetch(`https://api.github.com/repos/krishna2500/earn-or-die/actions/workflows/${workflowFile}/runs?per_page=1`, {
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "earn-or-die-worker/1.0",
      },
    });
    const text = await r.text();
    let last = null;
    try {
      last = JSON.parse(text).workflow_runs?.[0]?.created_at || null;
    } catch {}
    return { status: r.status, last, body: last ? null : text.slice(0, 160) };
  } catch (e) {
    return { status: 0, last: null, body: String(e?.message || e).slice(0, 160) };
  }
}

async function agentWatchdog(env) {
  const diag = { at: new Date().toISOString(), gh: !!env.GH_TOKEN };
  try {
    if (env.GH_TOKEN) {
      const jobs = [
        { wf: "agent.yml", staleMs: 6.5 * 3600 * 1000, cdKey: "meta:cd_core", label: "core cycle" },
        { wf: "scout.yml", staleMs: 50 * 60 * 1000, cdKey: "meta:cd_scout", label: "scout" },
      ];
      diag.jobs = [];
      for (const j of jobs) {
        const cd = Number((await env.ORDERS.get(j.cdKey)) || 0);
        const runs = await ghRuns(env, j.wf);
        const last = runs.last;
        const ageMin = last ? Math.round((Date.now() - Date.parse(last)) / 60000) : null;
        const entry = { wf: j.wf, st: runs.status, last, ageMin, cdSet: cd > 0 };
        if (runs.body) entry.body = runs.body;
        diag.jobs.push(entry);
        if (Date.now() - cd < 60 * 60 * 1000) { entry.action = "cooldown"; continue; }
        if (!last) { entry.action = "no-run-data"; continue; }
        if (Date.now() - Date.parse(last) < j.staleMs) { entry.action = "fresh"; continue; }
        await env.ORDERS.put(j.cdKey, String(Date.now()));
        const d = await fetch(`https://api.github.com/repos/krishna2500/earn-or-die/actions/workflows/${j.wf}/dispatches`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.GH_TOKEN}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": "earn-or-die-worker/1.0",
          },
          body: JSON.stringify({ ref: "main" }),
        });
        entry.action = `dispatch:${d.status}`;
        if (d.ok || d.status === 204) {
          await tg(env, `⏱ watchdog: ${j.label} stale — dispatched ${j.wf}`);
        } else if (d.status === 404) {
          await tg(env, `⏱ watchdog: ${j.wf} gone (dead or removed) — standing down`);
        }
      }
    } else {
      diag.action = "GH_TOKEN missing";
    }
  } catch (e) {
    diag.error = String(e?.message || e).slice(0, 200);
  }
  await env.ORDERS.put("meta:wd_last", JSON.stringify(diag), { expirationTtl: 3600 * 24 });
}

async function manualVerify(env, url) {
  if (env.VERIFY_KEY && url.searchParams.get("key") !== env.VERIFY_KEY) {
    return json({ error: "forbidden" }, 403);
  }
  return json({ checked: await verify(env) });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (ctx?.waitUntil) {
      const day = new Date().toISOString().slice(0, 10);
      const ip = request.headers.get("cf-connecting-ip") || "anon";
      ctx.waitUntil(
        (async () => {
          try {
            // max 1 count write per IP per minute (protects KV write quota)
            if (memGet(`h:${ip}`)) return;
            memSet(`h:${ip}`, 1, 60 * 1000);
            const k = `hits:${day}`;
            const n = Number((await env.ORDERS.get(k)) || 0) + 1;
            await env.ORDERS.put(k, String(n), { expirationTtl: 60 * 60 * 24 * 14 });
          } catch {}
        })()
      );
    }
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        const ts = Number((await env.ORDERS.get("meta:last_scheduled")) || 0);
        const day = new Date().toISOString().slice(0, 10);
        const hits = Number((await env.ORDERS.get(`hits:${day}`)) || 0);
        const wd = await env.ORDERS.get("meta:wd_last", { type: "json" });
        return json({
          ok: true,
          last_scheduled: ts ? new Date(ts).toISOString() : null,
          age_s: ts ? Math.round((Date.now() - ts) / 1000) : null,
          hits_today: hits,
          rate_limit_env: String(env.ORDER_RATE_LIMIT),
          watchdog: wd || null,
        });
      }
      if (request.method === "POST" && url.pathname === "/order") {
        return await createOrder(env, await request.json().catch(() => null), request.headers.get("cf-connecting-ip"));
      }
      if (request.method === "GET" && url.pathname === "/order") {
        return await getOrder(env, url.searchParams.get("id") || "");
      }
      if (request.method === "GET" && url.pathname === "/events") {
        return await getEvents(env, url.searchParams.get("since"));
      }
      if (request.method === "POST" && url.pathname === "/v1/invoice") {
        return await useInvoice(env, request);
      }
      if (request.method === "GET" && url.pathname === "/verify") {
        return await manualVerify(env, url);
      }
      if (request.method === "GET" && url.pathname === "/get") {
        return await getAsset(env, url);
      }
      if (request.method === "GET" && url.pathname === "/indexnow-key.txt") {
        return new Response(INDEXNOW_KEY, { headers: { "content-type": "text/plain" } });
      }
      if (request.method === "GET" && url.pathname === "/shop") {
        return shopPage(env);
      }
      if (request.method === "GET" && url.pathname === "/") {
        return statusPage(env);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        await env.ORDERS.put("meta:last_scheduled", String(Date.now()));
        await verify(env).catch(() => {});
        await agentWatchdog(env).catch(() => {});
      })()
    );
  },
};
