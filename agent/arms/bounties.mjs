import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = `${HERE}/../out`;

function parseAmount(text) {
  const m = String(text || "").match(/\$\s?([\d][\d,]*(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

export async function run() {
  const candidates = [];
  const seen = new Set();

  // GitHub issues labeled "bounty"
  try {
    const q = encodeURIComponent("label:bounty is:issue is:open sort:updated-desc");
    const headers = { accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const r = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=40`, { headers });
    if (r.ok) {
      const j = await r.json();
      for (const it of j.items || []) {
        const repo = (it.repository_url || "").replace("https://api.github.com/repos/", "");
        if (seen.has(it.html_url)) continue;
        seen.add(it.html_url);
        candidates.push({
          source: "github",
          repo,
          title: (it.title || "").slice(0, 140),
          url: it.html_url,
          amount: parseAmount(`${it.title} ${it.body || ""}`),
          comments: it.comments,
          updated: it.updated_at,
        });
      }
    }
  } catch (e) {
    candidates.push({ source: "github", error: String(e?.message || e).slice(0, 200) });
  }

  // Algora open bounties (best effort — API shape may change)
  try {
    const r = await fetch("https://algora.io/api/bounties?status=open&limit=40", {
      headers: { accept: "application/json" },
    });
    if (r.ok) {
      const j = await r.json();
      const items = Array.isArray(j) ? j : j.bounties || j.data || [];
      for (const b of items) {
        const url = b.issue_url || b.html_url || b.url;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        candidates.push({
          source: "algora",
          repo: b.repo || b.repository || null,
          title: (b.title || b.issue_title || "").slice(0, 140),
          url,
          amount: b.amount ?? parseAmount(b.title || b.body_text || ""),
          updated: b.updated_at || b.created_at || null,
        });
      }
    }
  } catch {}

  const withMoney = candidates.filter((c) => c.amount && !c.error);
  const noMoney = candidates.filter((c) => !c.amount && !c.error);
  withMoney.sort((a, b) => b.amount - a.amount);
  const top = [...withMoney, ...noMoney].slice(0, 25);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/bounties.json`, JSON.stringify(top, null, 2) + "\n");
  const md = [
    `# Bounty opportunities — ${new Date().toISOString()}`,
    "",
    ...top.map(
      (c, i) =>
        `${i + 1}. **$${c.amount ?? "?"}** — [${c.title || c.url}](${c.url}) \`${c.source}\`${c.repo ? " · " + c.repo : ""}`
    ),
  ].join("\n");
  writeFileSync(`${OUT}/bounties.md`, md + "\n");

  return { ok: true, total: candidates.length, payable: withMoney.length, candidates: top };
}
