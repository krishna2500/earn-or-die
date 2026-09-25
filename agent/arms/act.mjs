import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chat, extractJson, extractFence } from "../llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = `${HERE}/../out`;
const PRS = `${HERE}/../state/prs.json`;
const read = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
const write = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
};
const PATCHABLE = /\.(md|txt|js|mjs|cjs|json|ya?ml|py)$/i;
const DOCSY = /docs?|typo|readme|example|wording|spelling|link|comment|license|changelog|guidance|instruct/i;

async function gh(path, token, opts = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    method: opts.method || "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, data: j };
}
const sh = (args, opts = {}) => execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], ...opts }).toString();
const clean = (s, token) => String(s || "").replaceAll(token, "***");

function validate(path, content) {
  try {
    if (path.endsWith(".json")) JSON.parse(content);
    else if (/\.(m?js|cjs)$/.test(path)) {
      const f = join(tmpdir(), `v${Date.now()}.mjs`);
      writeFileSync(f, content);
      execFileSync("node", ["--check", f], { stdio: "pipe" });
      rmSync(f, { force: true });
    } else if (path.endsWith(".py")) {
      const f = join(tmpdir(), `v${Date.now()}.py`);
      writeFileSync(f, content);
      execFileSync("python3", ["-m", "py_compile", f], { stdio: "pipe" });
      rmSync(f, { force: true });
    }
    return null;
  } catch (e) {
    return String(e.stderr || e.message || e).slice(0, 300);
  }
}

async function attemptBounty(config, state, token, log) {
  const plan = read(`${OUT}/plan.json`, null);
  const prs = read(PRS, { items: [] });
  const wanted = (plan?.plan?.bounties || []).filter((b) => b.attempt);
  for (const b of wanted) {
    if (prs.items.some((i) => i.issue === b.url)) continue;
    const diffOk = b.difficulty === "easy" || DOCSY.test(b.approach || "") || DOCSY.test(b.url || "");
    if (!diffOk) { log.push(`skip ${b.url}: not easy/docs`); continue; }

    const m = (b.url || "").match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!m) continue;
    const [, owner, repoName, num] = m;
    const repoPath = `/repos/${owner}/${repoName}`;

    const issue = await gh(`${repoPath}/issues/${num}`, token);
    if (issue.status !== 200 || issue.data.state !== "open") { log.push(`skip ${b.url}: issue not open`); continue; }
    const meta = await gh(repoPath, token);
    if (meta.status !== 200 || meta.data.archived || meta.data.fork) { log.push(`skip ${b.url}: repo dead/fork`); continue; }
    const base = meta.data.default_branch;

    const trees = await gh(`${repoPath}/git/trees/${base}?recursive=1`, token);
    const paths = (trees.data?.tree || []).filter((t) => t.type === "blob" && PATCHABLE.test(t.path) && t.size < 60000).map((t) => t.path);
    if (!paths.length) { log.push(`skip ${b.url}: no patchable files`); continue; }

    let readme = "";
    const rmPath = paths.find((p) => /^readme/i.test(p));
    if (rmPath) {
      const rc = await gh(`${repoPath}/contents/${rmPath}`, token);
      if (rc.status === 200) readme = Buffer.from(rc.data.content || "", "base64").toString("utf8").slice(0, 2500);
    }

    // plan call
    const planRaw = await chat(
      "You fix GitHub issues. Reply ONLY minified JSON: {\"strategy\":\"<=160 chars\",\"files\":[\"path\",...],\"confidence\":0.0}",
      JSON.stringify({
        issue_title: issue.data.title,
        issue_body: String(issue.data.body || "").slice(0, 3500),
        readme: readme,
        file_paths: paths.slice(0, 220),
      })
    );
    const strat = extractJson(planRaw);
    if (!strat || !Array.isArray(strat.files) || !strat.files.length || (strat.confidence ?? 0) < 0.6) {
      log.push(`skip ${b.url}: low confidence`);
      continue;
    }
    const targets = strat.files.filter((f) => paths.includes(f)).slice(0, 2);
    if (!targets.length) { log.push(`skip ${b.url}: bad file pick`); continue; }

    // clone + patch
    const dir = mkdtempSync(join(tmpdir(), "fix-"));
    let branch = `agent-fix-${num}`;
    try {
      sh(["clone", "--depth", "1", `--branch`, base, `https://github.com/${owner}/${repoName}.git`, dir], { cwd: tmpdir() });
      const patches = [];
      for (const f of targets) {
        const cur = readFileSync(join(dir, f), "utf8");
        const raw = await chat(
          `You are editing ONE file to fix a GitHub issue. Output ONLY one fenced code block for the file ${f} — the COMPLETE new file content. No commentary outside the fence.`,
          JSON.stringify({ issue_title: issue.data.title, issue_body: String(issue.data.body || "").slice(0, 3000), strategy: strat.strategy, path: f, current_file: cur.slice(0, 14000) })
        );
        const next = extractFence(raw, f);
        if (!next || next.trim().length < 10 || next === cur) throw new Error(`empty/dup patch for ${f}`);
        const v = validate(f, next);
        if (v) throw new Error(`syntax ${f}: ${v}`);
        patches.push({ f, cur, next });
      }

      // reviewer call
      const judgeRaw = await chat(
        "You are a strict code reviewer. Reply ONLY minified JSON: {\"solves\":true|false,\"reason\":\"<=100 chars\"}",
        JSON.stringify({
          issue_title: issue.data.title,
          issue_body: String(issue.data.body || "").slice(0, 2500),
          strategy: strat.strategy,
          changes: patches.map((p) => ({ path: p.f, from: p.cur.slice(0, 1500), to: p.next.slice(0, 2500) })),
        })
      );
      const judge = extractJson(judgeRaw);
      if (!judge?.solves) { log.push(`skip ${b.url}: reviewer rejected (${judge?.reason || "?"})`); continue; }

      for (const p of patches) writeFileSync(join(dir, p.f), p.next);
      sh(["checkout", "-q", "-b", branch], { cwd: dir });
      sh(["add", "-A"], { cwd: dir });
      sh(["commit", "-qm", `fix: ${issue.data.title.slice(0, 60)} (#${num})`], { cwd: dir });

      // fork + push + PR
      const fork = await gh(repoPath + "/forks", token, { method: "POST", body: { default_branch_only: true } });
      if (fork.status !== 202 && fork.status !== 201) throw new Error(`fork ${fork.status}`);
      const auth = `https://x-access-token:${token}@github.com/${fork.data.full_name}.git`;
      try {
        sh(["push", "-qf", auth, `HEAD:refs/heads/${branch}`], { cwd: dir });
      } catch (e) {
        throw new Error("push failed: " + clean(String(e.stderr || e.message), token).slice(0, 200));
      }
      const pr = await gh(`${repoPath}/pulls`, token, {
        method: "POST",
        body: {
          title: `fix: ${issue.data.title.slice(0, 80)}`,
          head: `${fork.data.owner.login}:${branch}`,
          base,
          body: `Fixes #${num}\n\n_${strat.strategy}_\n\n<!-- autonomous fix attempt: syntax-validated + reviewer-passed -->`,
        },
      });
      if (pr.status !== 201) throw new Error(`pr ${pr.status}`);
      prs.items.push({ issue: b.url, pr: pr.data.html_url, at: new Date().toISOString(), files: targets, verdict: strat.strategy });
      write(PRS, prs);
      const fq = read(`${OUT}/fixqueue.json`, null);
      if (fq?.items) {
        const item = fq.items.find((i) => i.url === b.url);
        if (item) {
          item.status = "pr-open";
          item.pr = pr.data.html_url;
          write(`${OUT}/fixqueue.json`, fq);
        }
      }
      log.push(`PR OPENED ${pr.data.html_url}`);
      return { ok: true, status: `PR: ${pr.data.html_url}`, pr: pr.data.html_url };
    } catch (e) {
      log.push(`fail ${b.url}: ${clean(String(e?.message || e), token).slice(0, 160)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { ok: true, status: `no attempt (0 PRs)` };
}

async function writePost(plan, token, log) {
  const site = mkdtempSync(join(tmpdir(), "site-"));
  let pushed = false;
  try {
    // always work on a fresh clone so CI and local behave identically (agent publishes itself)
    if (token) {
      const auth = `https://x-access-token:${token}@github.com/krishna2500/krishna2500.github.io.git`;
      sh(["clone", "-q", auth, site], { cwd: tmpdir() });
    } else if (existsSync(`${HERE}/../../../krishna2500.github.io/.git`)) {
      sh(["clone", "-q", `${HERE}/../../../krishna2500.github.io`, site], { cwd: tmpdir() });
    } else {
      return { ok: false, error: "no token to publish" };
    }
    const blogDir = join(site, "blog");
    mkdirSync(blogDir, { recursive: true });
    const existing = readdirSync(blogDir).filter((f) => f.endsWith(".html"));
    const titles = existing.map((f) => f.replace(/\.html$/, ""));
    if (existing.length >= 12) return { ok: true, status: "post cap reached (12)" };
    const ideas = (plan?.plan?.next_content || []).filter((i) => !titles.some((t) => t.includes(i.toLowerCase().slice(0, 20))));
    const idea = ideas[0] || `guide on accepting usdt payments ${new Date().toISOString().slice(0, 10)}`;

    const html = await chat(
      `You write ONE honest SEO blog post as complete HTML for krishna2500.github.io. STRICT: 800-1000 words (this means the rendered article body, NOT a stub — aim for over 6000 bytes of HTML). doctype html, lang en, dark style block copied from existing posts, <meta name="description">, canonical link, NO <script>, NO analytics, links ONLY to github.com/krishna2500/*, krishna2500.github.io/*, earn-or-die-pay.leadrescue.workers.dev/* — never any other URL. No invented statistics or fake claims, practical developer tone, include an h2-structured walkthrough. Output ONLY one fenced html block, nothing else.`,
      JSON.stringify({ idea, existing_titles: titles, style_head: readFileSync(join(blogDir, existing[0]), "utf8").slice(0, 1400) })
    );
    const body = extractFence(html, ".html");
    if (!body || !/<!doctype html>/i.test(body) || !/<\/html>/i.test(body)) throw new Error("bad html");
    const words = body.replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;
    if (body.length < 5500 || words < 500) throw new Error(`too short ${body.length}B/${words}w`);
    const badLinks = [...body.matchAll(/https?:\/\/([^/"'\s]+)/g)].map((x) => x[1]).filter(
      (h) => !/(^|\.)github\.com$|githubusercontent\.com$|krishna2500\.github\.io$|workers\.dev$|github\.io$/.test(h)
    );
    if (badLinks.length) throw new Error(`foreign links: ${badLinks.slice(0, 3).join(",")}`);

    const titleMatch = body.match(/<title>([^<]+)<\/title>/i);
    const slug = (titleMatch?.[1] || idea).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || `post-${Date.now()}`;
    const fname = existing.includes(slug) ? `${slug}-${existing.length}` : slug;
    writeFileSync(join(blogDir, `${fname}.html`), body + "\n");

    const idxPath = join(site, "index.html");
    if (existsSync(idxPath)) {
      let idx = readFileSync(idxPath, "utf8");
      const li = `<li><a href="/blog/${fname}.html">${(titleMatch?.[1] || idea).replace(/[<>&]/g, "")}</a></li>`;
      if (idx.includes('<li><a href="/blog/')) idx = idx.replace(/(\s*)(<li><a href="\/blog\/)/, `$1${li}$1$2`);
      else idx = idx.replace("</body>", `${li}</body>`);
      writeFileSync(idxPath, idx);
    }
    const smPath = join(site, "sitemap.xml");
    if (existsSync(smPath)) {
      let sm = readFileSync(smPath, "utf8");
      sm = sm.replace("</urlset>", `<url><loc>https://krishna2500.github.io/blog/${fname}.html</loc></url>\n</urlset>`);
      writeFileSync(smPath, sm);
    }

    sh(["config", "user.name", "earn-or-die-agent"], { cwd: site });
    sh(["config", "user.email", "earn-or-die-agent@users.noreply.github.com"], { cwd: site });
    sh(["add", "-A"], { cwd: site });
    sh(["commit", "-qm", `content: ${fname}`], { cwd: site });
    sh(["push", "-q"], { cwd: site });
    pushed = true;
    log.push(`POST WRITTEN+PUSHED blog/${fname}.html (${body.length} bytes)`);
    return { ok: true, status: `post: blog/${fname}.html`, post: fname };
  } finally {
    rmSync(site, { recursive: true, force: true });
    if (!pushed) log.push("post attempt not published");
  }
}

export async function run(config, state) {
  const token = process.env.GH_TOKEN;
  const log = [];
  const prev = state.armStatus?.act || {};
  const today = new Date().toISOString().slice(0, 10);
  const day = prev.date === today ? prev : { date: today, prs: 0, posts: 0 };
  const plan = read(`${OUT}/plan.json`, null);
  const result = { date: today, prs: day.prs, posts: day.posts };

  try {
    // 1) earn directly: open a validated PR (1/day)
    if (day.prs < 1 && token) {
      const r = await attemptBounty(config, state, token, log);
      Object.assign(result, r);
      if (r.pr) result.prs += 1;
    }
    // 2) otherwise grow traffic: write one SEO post (1/day)
    if (log.every((l) => !l.startsWith("PR OPENED")) && day.posts < 1) {
      const r = await writePost(plan, token, log);
      Object.assign(result, r);
      if (r.post) result.posts += 1;
    }
    if (!log.length) log.push("nothing to do (caps or no candidates)");
  } catch (e) {
    result.ok = false;
    result.error = String(e?.message || e).slice(0, 250);
    log.push("error: " + result.error);
  }
  result.log = log;
  result.status = result.status || log[log.length - 1];
  return result;
}
