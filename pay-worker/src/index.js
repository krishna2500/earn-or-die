const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ORDER_TTL = 1800;
const MAX_PENDING = 60;

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

async function createOrder(env, body) {
  const product = String(body?.product || "unknown").slice(0, 80);
  const price = Number(body?.price);
  if (!Number.isFinite(price) || price < 0.5 || price > 500) {
    return json({ error: "price must be 0.5-500 USDT" }, 400);
  }
  let order = null;
  for (let i = 0; i < 30; i++) {
    const suffix = Math.floor(Math.random() * 9000) + 1000;
    const amount = (price + suffix / 1e6).toFixed(6);
    const existing = await env.ORDERS.get(`amt:${amount}`);
    if (existing) continue;
    const id = crypto.randomUUID();
    const now = Date.now();
    order = {
      id,
      product,
      price,
      amount,
      created: now,
      expires: now + ORDER_TTL * 1000,
      status: "pending",
    };
    await env.ORDERS.put(`order:${id}`, JSON.stringify(order), { expirationTtl: 3600 });
    await env.ORDERS.put(`amt:${amount}`, id, { expirationTtl: 3600 });
    break;
  }
  if (!order) return json({ error: "no unique amount available, retry" }, 503);
  return json({
    order_id: order.id,
    pay_exact: order.amount,
    asset: env.ASSET,
    network: env.NETWORK,
    address: env.WALLET,
    expires_at: new Date(order.expires).toISOString(),
    how: `Send EXACTLY ${order.amount} ${env.ASSET} on ${env.NETWORK} to the address. Payment auto-detected on-chain.`,
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
  return json({ order_id: o.id, status: o.status, product: o.product, pay_exact: o.amount, paid_tx: o.tx || null });
}

async function getEvents(env, since) {
  const raw = (await env.ORDERS.get("events", { type: "json" })) || [];
  const t = since ? Date.parse(since) || 0 : 0;
  return json({ events: raw.filter((e) => Date.parse(e.ts) > t) });
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

  const r = await fetch(
    `https://api.trongrid.io/v1/accounts/${env.WALLET}/transactions/trc20?only_to=true&limit=50`,
    { headers: { accept: "application/json" } }
  );
  if (!r.ok) return 0;
  const { data = [] } = await r.json();

  let paid = 0;
  for (const tx of data) {
    if (tx.token_info?.address && tx.token_info.address !== USDT_CONTRACT) continue;
    const seen = await env.ORDERS.get(`seen:${tx.transaction_id}`);
    if (seen) continue;
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

    await tg(env, `💰 PAID ${match.price} ${env.ASSET} — ${match.product}\ntx: ${tx.transaction_id}`);
    paid++;
    orders.splice(orders.indexOf(match), 1);
  }
  return paid;
}

const page = (env) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>EARN-OR-DIE pay rail</title>
<body style="font-family:system-ui;background:#0b0f14;color:#d7f5e9;padding:40px;max-width:640px">
<h1>💰 EARN-OR-DIE — payment rail</h1>
<p>status: <b style="color:#4ade80">LIVE</b> · on-chain verification (no gateway, no KYC)</p>
<p>pay to: <code style="user-select:all">${env.WALLET}</code> (${env.NETWORK} ${env.ASSET})</p>
<p>orders: <code>POST /order {product, price}</code> · check: <code>GET /order?id=</code> · events: <code>GET /events?since=</code></p>
</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );

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
      if (request.method === "GET" && url.pathname === "/verify") {
        return json({ checked: await verify(env) });
      }
      if (request.method === "GET" && url.pathname === "/") {
        return page(env);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(verify(env).catch(() => {}));
  },
};
