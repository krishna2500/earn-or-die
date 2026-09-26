import { dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = "1530340e4319a39160b5bed310e8f7d6";
const SHOP = "https://earn-or-die-pay.leadrescue.workers.dev/shop";
const CTA = `<p style="text-align:center;margin:40px 0 8px"><a href="${SHOP}">Start accepting USDT → CryptoPay Shop</a></p>`;

const gh = async (path, token, method = "GET", body) => {
  try {
    const r = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "earn-or-die-grow/1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {}
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: null, error: String(e.message || e) };
  }
};

const fetchText = async (u) => {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    return r.ok ? r.text() : null;
  } catch {
    return null;
  }
};

async function ensureTopics(token, log) {
  const want = ["usdt", "trc20", "payment-gateway", "crypto-payments", "cloudflare-workers"];
  const cur = await gh("/repos/krishna2500/usdt-paykit/topics", token);
  if (cur.status !== 200) {
    log.push(`topics read ${cur.status}`);
    return;
  }
  const have = cur.data?.names || [];
  const missing = want.filter((t) => !have.includes(t));
  if (!missing.length) {
    log.push("topics ok");
    return;
  }
  const put = await gh("/repos/krishna2500/usdt-paykit/topics", token, "PUT", { names: [...new Set([...have, ...want])] });
  log.push(`topics +${missing.join(",")} → ${put.status}`);
}

async function ensureCta(token, log) {
  const sm = await fetchText("https://krishna2500.github.io/sitemap.xml");
  if (!sm) {
    log.push("sitemap fetch failed");
    return;
  }
  const posts = [...sm.matchAll(/<loc>(https:\/\/krishna2500\.github\.io\/blog\/[^<]+)<\/loc>/g)].map((m) => m[1]);
  let added = 0;
  for (const url of posts) {
    const raw = await fetchText(url);
    if (raw && raw.includes("earn-or-die-pay.leadrescue.workers.dev/shop")) continue;
    const path = url.replace("https://krishna2500.github.io/", "");
    const meta = await gh(`/repos/krishna2500/krishna2500.github.io/contents/${path}`, token);
    if (meta.status !== 200) {
      log.push(`cta read ${path} → ${meta.status}`);
      continue;
    }
    let html = Buffer.from(String(meta.data?.content || ""), "base64").toString("utf8");
    if (html.includes("earn-or-die-pay.leadrescue.workers.dev/shop")) continue;
    html = html.includes("</body>") ? html.replace("</body>", `${CTA}\n</body>`) : `${html}\n${CTA}`;
    const put = await gh(`/repos/krishna2500/krishna2500.github.io/contents/${path}`, token, "PUT", {
      message: `seo: shop CTA in ${path}`,
      content: Buffer.from(html).toString("base64"),
      sha: meta.data?.sha,
      branch: "main",
    });
    if (put.status === 200) added++;
    else log.push(`cta push ${path} → ${put.status}`);
  }
  log.push(`cta ${posts.length} posts → ${added} updated`);
}

async function indexNow(log) {
  const sm = await fetchText("https://krishna2500.github.io/sitemap.xml");
  const locs = sm ? [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]) : [];
  const jobs = [
    { host: "krishna2500.github.io", keyLocation: "https://krishna2500.github.io/indexnow-key.txt", urls: locs.filter((u) => u.includes("krishna2500.github.io")) },
    { host: "earn-or-die-pay.leadrescue.workers.dev", keyLocation: `${SHOP.split("/shop")[0]}/indexnow-key.txt`, urls: [SHOP] },
  ];
  for (const j of jobs) {
    if (!j.urls.length) {
      log.push(`indexnow ${j.host}: no urls`);
      continue;
    }
    try {
      const r = await fetch("https://api.indexnow.org/indexnow", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: j.host, key: KEY, keyLocation: j.keyLocation, urlList: j.urls.slice(0, 10000) }),
        signal: AbortSignal.timeout(20000),
      });
      log.push(`indexnow ${j.host}: ${r.status} (${j.urls.length} urls)`);
    } catch (e) {
      log.push(`indexnow ${j.host}: fail ${String(e.message || e).slice(0, 60)}`);
    }
  }
}

export async function run(config, state) {
  const token = process.env.GH_TOKEN;
  const log = [];
  try {
    if (token) await ensureTopics(token, log);
    else log.push("no GH token");
    if (token) await ensureCta(token, log);
    await indexNow(log);
    return { ok: true, status: log.join(" · ").slice(0, 240), log, at: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 250), log };
  }
}
