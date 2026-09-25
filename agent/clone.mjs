import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = `${HERE}/state`;
const read = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
const write = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
};

const clean = (s, token) => String(s || "").replaceAll(token || "\u0000", "***");

const LANDING = (p, env) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${p.title} — ${p.pitch.split("—")[0].trim()}</title>
<meta name="description" content="${p.pitch}">
<style>body{font-family:ui-sans-serif,system-ui;max-width:720px;margin:60px auto;padding:0 20px;background:#0b1220;color:#dbe7ff}
h1{font-size:2rem}a{color:#4ade80}.c{background:#111a2e;border:1px solid #1e2a44;border-radius:14px;padding:22px;margin:24px 0}
.btn{display:inline-block;background:#16a34a;color:#fff;padding:13px 26px;border-radius:10px;text-decoration:none;font-weight:700}
.m{color:#7f95b5;font-size:.9rem}</style></head><body>
<h1>${p.title}</h1>
<p>${p.pitch}</p>
<div class="c"><p><b>How it works:</b> exact-amount USDT invoice → automatic on-chain verification on TRC-20 → access key issued instantly. No gateway, no KYC, no country blocks.</p>
<p>Money lands directly in the operator wallet. Verification runs on Cloudflare Workers free tier with TronGrid (no API keys).</p>
<a class="btn" href="${env?.shop || "https://earn-or-die-pay.leadrescue.workers.dev/shop"}">Open the shop →</a></div>
<p class="m">payout: TL5YPXfZvokPy2TMtULRXmXRkzYbmmvevy (USDT TRC-20) · source: github.com/krishna2500/earn-or-die</p>
</body></html>
`;

async function ghCreateRepo(token, name, description) {
  const r = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    body: JSON.stringify({ name, description, private: false, auto_init: false }),
  });
  if (r.status === 422) return { exists: true };
  if (!r.ok) throw new Error(`repo create ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function pushSite(token, slug, files) {
  const dir = join(STATE, "clones", slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const run = (args, opts = {}) =>
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, ...opts });
  if (!existsSync(join(dir, ".git"))) run(["init", "-q"]);
  run(["add", "-A"]);
  try {
    run(["commit", "-qm", `launch: ${slug}`]);
  } catch (e) {
    /* nothing to commit */
  }
  const remote = `https://x-access-token:${token}@github.com/krishna2500/${slug}.git`;
  try {
    run(["push", "-qf", remote, "HEAD:main"]);
  } catch (e) {
    const msg = clean(`${e.stdout || ""}${e.stderr || ""}`, token);
    if (!/already up|Everything up|non-fast/.test(msg)) throw new Error("push failed: " + msg.slice(0, 300));
  }
}

function deployPages(slug) {
  const dir = join(STATE, "clones", slug);
  const out = [];
  const tryRun = (args) => {
    try {
      out.push(execFileSync("npx", ["wrangler", ...args], { cwd: `${HERE}/../pay-worker`, stdio: ["ignore", "pipe", "pipe"] }).toString().trim().split("\n").pop());
    } catch (e) {
      out.push("wrangler: " + String(e.stdout || e.stderr || e.message).trim().split("\n").pop());
    }
  };
  tryRun(["pages", "project", "create", slug, "--production-branch=main"]);
  tryRun(["pages", "deploy", dir, "--project-name=" + slug, "--branch=main"]);
  return out;
}

export async function run(config, state, opts = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: "no GH token" };
  const fleet = read(`${STATE}/fleet.json`, { clones: [] });
  const have = Number(state.totalRevenue || 0);
  const need = config.fleet?.cloneAfterUSD ?? Infinity;
  if (!opts.force && have < need) {
    return { ok: true, status: "waiting-for-revenue", have, need, clones: fleet.clones.length };
  }
  const max = config.fleet?.maxClones ?? 0;
  const pending = (config.fleet?.plan || []).filter((p) => !fleet.clones.some((c) => c.slug === p.slug));
  if (!pending.length || fleet.clones.length >= max) {
    return { ok: true, status: fleet.clones.length >= max ? "fleet-full" : "plan-exhausted", clones: fleet.clones };
  }
  const plan = opts.only ? pending.find((p) => p.slug === opts.only) || pending[0] : pending[0];

  const result = { slug: plan.slug, at: new Date().toISOString() };
  try {
    const repo = await ghCreateRepo(token, plan.slug, `${plan.title} — ${plan.pitch}`);
    result.repo = `krishna2500/${plan.slug}`;
    const dir = join(STATE, "clones", plan.slug);
    pushSite(token, plan.slug, {
      "index.html": LANDING(plan),
      "README.md": `# ${plan.title}\n\n${plan.pitch}\n\nShop: https://earn-or-die-pay.leadrescue.workers.dev/shop\n\nPart of the [earn-or-die](https://github.com/krishna2500/earn-or-die) fleet — clones launch only after first revenue.\n`,
    });
    result.repoUrl = `https://github.com/${result.repo}`;
    if (!process.env.CLONE_NO_PAGES) {
      result.pages = deployPages(plan.slug);
      result.site = `https://${plan.slug}.pages.dev`;
    }
    fleet.clones.push(result);
    write(`${STATE}/fleet.json`, fleet);
    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.error = clean(String(e?.message || e), token).slice(0, 300);
  }
  return { ok: result.ok, launched: result, clones: fleet.clones.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(`${HERE}/../config.json`, "utf8"));
  const state = read(`${STATE}/state.json`, { totalRevenue: 0 });
  const opts = {
    force: process.argv.includes("--force"),
    only: (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1],
  };
  run(config, state, opts).then((r) => console.log(JSON.stringify(r, null, 2)));
}
