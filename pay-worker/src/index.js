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
    const order = { id, product, price, amount, created: now, expires: now + ORDER_TTL * 1000, status: "pending" };
    await env.ORDERS.put(`order:${id}`, JSON.stringify(order), { expirationTtl: 3600 });
    await env.ORDERS.put(`amt:${amount}`, id, { expirationTtl: 3600 });
    return order;
  }
  return null;
}

async function createOrder(env, body) {
  const product = String(body?.product || "").trim();
  const fromShop = SHOP[product];
  const price = fromShop ? fromShop.price : Number(body?.price);
  if (!Number.isFinite(price) || price < 0.5 || price > 500) {
    return json({ error: "unknown product or price must be 0.5-500 USDT" }, 400);
  }
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
    await env.ORDERS.put(`order:${id}`, JSON.stringify(o), { expirationTtl: 3600 });
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
  const list = await env.ORDERS.list({ prefix: "order:", limit: 200 });
  const orders = [];
  for (const k of list.keys) {
    const raw = await env.ORDERS.get(k.name);
    if (!raw) continue;
    const o = JSON.parse(raw);
    if (o.status === "pending" && Date.now() > o.expires) {
      o.status = "expired";
      await env.ORDERS.put(k.name, JSON.stringify(o), { expirationTtl: 3600 });
      continue;
    }
    if (o.status === "pending") orders.push(o);
    if (orders.length >= MAX_PENDING) break;
  }
  if (!orders.length) return 0;

  const src = env.VERIFY_MOCK_URL || `https://api.trongrid.io/v1/accounts/${env.WALLET}/transactions/trc20?only_to=true&limit=50`;
  const r = await fetch(src, { headers: { accept: "application/json" } });
  if (!r.ok) return 0;
  const { data = [] } = await r.json();

  let paid = 0;
  for (const tx of data) {
    if (tx.token_info?.address && tx.token_info.address !== USDT_CONTRACT) continue;
    if (await env.ORDERS.get(`seen:${tx.transaction_id}`)) continue;
    const value = Number(tx.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    const amountStr = (value / 1e6).toFixed(6);
    const txTime = tx.block_timestamp || 0;
    const match = orders.find((o) => o.amount === amountStr && o.created <= txTime);
    if (!match) continue;

    match.status = "paid";
    match.tx = tx.transaction_id;
    match.paidAt = new Date(txTime).toISOString();
    match.payer = tx.from;
    await provision(env, match);
    await env.ORDERS.put(`order:${match.id}`, JSON.stringify(match), { expirationTtl: 86400 * 30 });
    await env.ORDERS.put(`amt:${match.amount}`, match.id, { expirationTtl: 86400 * 30 });
    await env.ORDERS.put(`seen:${tx.transaction_id}`, match.id, { expirationTtl: 86400 * 30 });

    const events = (await env.ORDERS.get("events", { type: "json" })) || [];
    events.push({
      ts: new Date().toISOString(),
      order_id: match.id,
      product: match.product,
      amount: match.price,
      currency: env.ASSET,
      tx: tx.transaction_id,
      note: `${match.product} on-chain verified`,
    });
    while (events.length > 500) events.shift();
    await env.ORDERS.put("events", JSON.stringify(events));

    await tg(
      env,
      `💰 PAID ${match.price} ${env.ASSET} — ${match.product}\ntx: ${tx.transaction_id}` +
        (match.access_key ? `\nkey: ${match.access_key}` : "")
    );
    paid++;
    orders.splice(orders.indexOf(match), 1);
  }
  return paid;
}

const page = (env, body, title = "EARN-OR-DIE") =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
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

const shopPage = (env) =>
  page(
    env,
    `<h1>🧾 CryptoPay Shop</h1>
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
</script>`
  );

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

async function agentWatchdog(env) {
  if (!env.GH_TOKEN) return;
  const COOLDOWN = 60 * 60 * 1000;
  const cd = Number((await env.ORDERS.get("meta:dispatch_cd")) || 0);
  if (Date.now() - cd < COOLDOWN) return;
  const r = await fetch("https://api.github.com/repos/krishna2500/earn-or-die/actions/runs?per_page=1", {
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json" },
  });
  if (!r.ok) return;
  const j = await r.json();
  const last = j.workflow_runs?.[0]?.created_at;
  if (!last) return;
  if (Date.now() - Date.parse(last) < 6.5 * 3600 * 1000) return;

  await env.ORDERS.put("meta:dispatch_cd", String(Date.now()));
  const d = await fetch("https://api.github.com/repos/krishna2500/earn-or-die/actions/workflows/agent.yml/dispatches", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (d.ok || d.status === 204) {
    await tg(env, "⏱ watchdog: agent cycle stale — dispatched manually");
  } else if (d.status === 404) {
    await tg(env, "⏱ watchdog: workflow gone (agent dead or removed) — standing down");
  }
}

async function manualVerify(env, url) {
  if (env.VERIFY_KEY && url.searchParams.get("key") !== env.VERIFY_KEY) {
    return json({ error: "forbidden" }, 403);
  }
  return json({ checked: await verify(env) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/order") {
        return await createOrder(env, await request.json().catch(() => null));
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
    ctx.waitUntil(verify(env).catch(() => {}));
    ctx.waitUntil(agentWatchdog(env).catch(() => {}));
  },
};
