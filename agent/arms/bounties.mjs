import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = `${HERE}/../out`;
const SEEN = `${HERE}/../state/seen_issues.json`;

const SPAM = /bug-bounty|bountyfarmer|bounty-plaza|gullible|for-funsies|zero-bounty|BountyScout|oss-hunter|misaka|livefire|discordLegacyBot|bugb|test-target/i;
const OFF_LIMITS = /captcha|hcapcha|hcaptcha|recaptcha|romance|sugar|deepfake/i;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function parseAmount(text) {
  const m = String(text || "").match(/\$\s?([\d][\d,]*(?:\.\d+)?)(k)?\b/i);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ""));
  return m[2] ? v * 1000 : v;
}
function labelAmount(labels = []) {
  for (const name of labels) {
    const m = String(name).match(/^\$\s?([\d.]+)\s*(k)?$/i);
    if (m) return Number(m[1]) * (m[2] ? 1000 : 1);
  }
  return null;
}

async function gh(path, token) {
  const h = { accept: "application/vnd.github+json" };
  if (token) h.authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com${path}`, { headers: h });
  if (!r.ok) return null;
  return r.json();
}
async function ghSearch(q, token) {
  const h = { accept: "application/vnd.github+json" };
  if (token) h.authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100`, { headers: h });
  if (!r.ok) return [];
  return (await r.json()).items || [];
}

export async function run() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const seen = existsSync(SEEN) ? JSON.parse(readFileSync(SEEN, "utf8")) : {};
  const seenBefore = Object.keys(seen).length;
  const prevFresh = existsSync(`${OUT}/bounties.json`)
    ? (JSON.parse(readFileSync(`${OUT}/bounties.json`, "utf8")).fresh || []).map((c) => c.url)
    : [];
  const candidates = [];
  const add = (c) => {
    if (candidates.some((x) => x.url === c.url)) return;
    const hay = `${c.repo || ""} ${c.title || ""}`;
    if (SPAM.test(hay) || OFF_LIMITS.test(hay)) return;
    candidates.push(c);
  };

  // ---- 1. Algora funded bounties (💎 Bounty label), fresh window first ----
  try {
    for (const q of [
      `label:"💎 Bounty" is:issue is:open created:>=${daysAgo(14)}`,
      `label:"💎 Bounty" is:issue is:open`,
    ]) {
      const items = await ghSearch(q, token);
      await new Promise((r) => setTimeout(r, 2300));
      const byRepo = {};
      for (const it of items) {
        const repo = (it.repository_url || "").replace("https://api.github.com/repos/", "");
        byRepo[repo] = (byRepo[repo] || 0) + 1;
        const labels = (it.labels || []).map((l) => l.name);
        add({
          source: "algora",
          repo,
          title: (it.title || "").slice(0, 140),
          url: it.html_url,
          amount: labelAmount(labels) ?? parseAmount(it.title),
          comments: it.comments,
          created: it.created_at,
          updated: it.updated_at,
          labelCount: labels.length,
          body: (it.body || "").slice(0, 1200),
        });
      }
      // farm marker: repo with huge open-bounty count
      for (const c of candidates) if (c.source === "algora" && byRepo[c.repo] > 15) c.farm = true;
    }
  } catch (e) {
    candidates.push({ source: "algora", error: String(e?.message || e).slice(0, 200) });
  }

  // ---- 2. Opire live rewards feed ----
  try {
    const r = await fetch("https://api.opire.dev/rewards", { headers: { accept: "application/json" } });
    if (r.ok) {
      const rewards = await r.json();
      for (const w of rewards || []) {
        const m = (w.url || "").match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
        if (!m) continue;
        const issue = await gh(`/repos/${m[1]}/${m[2]}/issues/${m[3]}`, token);
        if (!issue || issue.state !== "open") continue;
        add({
          source: "opire",
          repo: `${m[1]}/${m[2]}`,
          title: (w.title || issue.title || "").slice(0, 140),
          url: w.url,
          amount: w.pendingPrice?.value ? w.pendingPrice.value / 100 : null,
          claims: (w.claimerUsers || []).length,
          comments: issue.comments,
          created: issue.created_at,
          updated: issue.updated_at,
          body: (issue.body || "").slice(0, 1200),
        });
        await new Promise((x) => setTimeout(x, 350));
      }
    }
  } catch (e) {
    candidates.push({ source: "opire", error: String(e?.message || e).slice(0, 200) });
  }

  // ---- 3. Generic label:bounty (keep scanning, heavily filtered) ----
  try {
    const items = await ghSearch("label:bounty is:issue is:open sort:created-desc", token);
    for (const it of items.slice(0, 60)) {
      const repo = (it.repository_url || "").replace("https://api.github.com/repos/", "");
      const amt = parseAmount(`${it.title} ${it.body || ""}`);
      if (!amt || amt < 20) continue;
      if (SPAM.test(repo) || SPAM.test(it.title || "")) continue;
      add({
        source: "github",
        repo,
        title: (it.title || "").slice(0, 140),
        url: it.html_url,
        amount: amt,
        comments: it.comments,
        created: it.created_at,
        updated: it.updated_at,
        body: (it.body || "").slice(0, 1200),
      });
    }
  } catch (e) {
    candidates.push({ source: "github", error: String(e?.message || e).slice(0, 200) });
  }

  // ---- 4. Enrich top candidates: repo health + zombie detection ----
  const payable = candidates.filter((c) => !c.error && !c.farm && c.amount && c.amount >= 20);
  payable.sort((a, b) => (b.created > a.created ? 1 : -1));
  const top = payable.slice(0, 12);
  for (const c of top) {
    const [owner, repoName] = (c.repo || "").split("/");
    if (!owner) continue;
    const meta = await gh(`/repos/${owner}/${repoName}`, token);
    if (!meta) {
      c.dead = true;
      continue;
    }
    c.stars = meta.stargazers_count;
    c.repoArchived = meta.archived;
    c.repoPushed = meta.pushed_at;
    if (meta.archived || meta.disabled) c.dead = true;
    if (meta.created_at > daysAgo(45)) c.dead = true; // brand-new repo = likely farm
    const comments = await gh(`/repos/${owner}/${repoName}/issues/${c.url.split("/").pop()}/comments?per_page=30`, token);
    if (Array.isArray(comments) && comments.length) {
      const last = comments[comments.length - 1];
      c.lastCommentAt = last.created_at;
      c.lastCommentBy = last.user?.login;
      const owners = new Set([meta.owner?.login]);
      const maintainerActive = comments.some((x) => owners.has(x.user?.login));
      const age = (Date.now() - +new Date(last.created_at)) / 86400000;
      c.zombie = age > 120 && c.comments > 5 && !maintainerActive;
    }
    // repo with <10 stars paying bounties = likely farm
    if ((c.stars ?? 0) < 10) c.farm = true;
    await new Promise((x) => setTimeout(x, 350));
  }

  // ---- score ----
  const score = (c) => {
    let s = 0;
    if (c.dead || c.farm) return -100;
    s += Math.min(c.amount / 50, 40);
    if (c.created && +new Date(c.created) > Date.now() - 7 * 86400000) s += 30;
    if (c.source === "opire" && c.claims === 0) s += 25;
    if ((c.comments ?? 0) <= 3) s += 15;
    if (c.zombie) s -= 40;
    if ((c.stars ?? 0) >= 500) s += 15;
    else if ((c.stars ?? 0) >= 50) s += 5;
    const firstSeen = seen[c.url];
    if (!firstSeen) s += 10;
    return s;
  };
  for (const c of payable) c.score = score(c);
  const ranked = payable.sort((a, b) => b.score - a.score).slice(0, 25);

  // update seen (persist only when it grew)
  for (const c of candidates) if (c.url) seen[c.url] = seen[c.url] || iso(new Date());
  if (Object.keys(seen).length > seenBefore) {
    mkdirSync(`${HERE}/../state`, { recursive: true });
    writeFileSync(SEEN, JSON.stringify(seen, null, 2) + "\n");
  }

  mkdirSync(OUT, { recursive: true });
  const fresh = ranked.filter((c) => !c.dead && !c.farm && !c.zombie && c.score > 40);
  const freshUrls = fresh.map((c) => c.url);
  const changed = JSON.stringify(freshUrls) !== JSON.stringify(prevFresh);

  if (changed) {
    writeFileSync(`${OUT}/bounties.json`, JSON.stringify({ fresh, all: ranked }, null, 2) + "\n");
    // fix queue: what the solver agent should attempt (with issue body)
    writeFileSync(
      `${OUT}/fixqueue.json`,
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          items: fresh.map((c) => ({
            url: c.url,
            repo: c.repo,
            title: c.title,
            amount: c.amount,
            source: c.source,
            score: c.score,
            body: c.body || "",
            status: "todo",
          })),
        },
        null,
        2
      ) + "\n"
    );
    const md = [
      `# Bounty opportunities — ${new Date().toISOString()}`,
      "",
      `## ACTIONABLE (${fresh.length})`,
      ...fresh.map(
        (c, i) =>
          `${i + 1}. **$${c.amount}** — [${c.title || c.url}](${c.url}) \`${c.source}\` · ${c.repo} · score ${c.score}${c.claims === 0 ? " · zero claims" : ""}`
      ),
      "",
      `## WATCHLIST (deprioritized: ${ranked.length - fresh.length})`,
      ...ranked
        .filter((c) => !fresh.includes(c))
        .map(
          (c) =>
            `- $${c.amount} [${c.title || c.url}](${c.url}) — ${c.dead ? "repo dead" : c.farm ? "farm" : c.zombie ? "zombie (no maintainer)" : "low score"}`
        ),
    ].join("\n");
    writeFileSync(`${OUT}/bounties.md`, md + "\n");
  }

  return {
    ok: true,
    total: candidates.length,
    payable: payable.length,
    actionable: fresh.length,
    changed,
    candidates: fresh,
  };
}
