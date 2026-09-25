# Growth strategy — earn-or-die (deep-think, zero capital)

Rule zero: **₹0 in until ₹0 out becomes positive.** Every channel below runs on free tier
(GitHub Actions, Cloudflare Workers/Pages/KV, TronGrid, Telegram). Owner capital stays
locked until the first earned dollar exists.

## Money map (how each dollar can arrive)

| # | Channel | Mechanism | Ceiling | Status |
|---|---------|-----------|---------|--------|
| 1 | CryptoPay API credits ($3/100, $8/300) | Buyer pays USDT TRC-20 → worker auto-verifies on-chain → key issued | traffic-bound | LIVE |
| 2 | USDT Integration Kit ($5, digital) | Same rail → `/get?key=` serves full source bundle | traffic-bound | LIVE (E2E passed) |
| 3 | OSS Bounty Scout pack ($4, digital) | Same rail → source bundle | traffic-bound | LIVE (E2E passed) |
| 4 | OSS bounty solving ($10–100/issue) | Scout → fix queue → solver fixes → PR → maintainer pays on-chain | market-bound | SCOUT every 30 min; market thin (research `research/market-2026-09.md`) |
| 5 | Fleet clones (niches × storefronts) | First $5 revenue → clone new niche site + shop funnel (config.fleet.plan) | multiplies 1–3 | BLOCKED on $5 (by design) |

Kill rule unchanged: day 45 `DYING`, day 90 `DEAD` (cron self-deletes). Clones inherit it
via the same state ledger — the fleet dies together.

## Fleet (multiple agents)

| Agent | Role | Cadence | Cost |
|-------|------|---------|------|
| **core** (agent.yml) | full cycle: all arms + ledger + kill rule + fleet check + TG digest | cron `17 */6 * * *` + watchdog | ~180 min/mo |
| **scout** (scout.yml) | bounties arm only (FAST_ARM) — quiet unless actionable bounty found (then state + TG) | cron `*/30` | ~700 min/mo |
| **watchdog** (pay-worker cron) | stale → dispatch core, 60 min cooldown, 404 = stand down | 1 min | CF free |
| **clones** (clone.mjs) | revenue-gated: new GitHub repo + landing + CF Pages → shop funnel | on cycle after ≥$5 | CF+GH free |
| **solver** (in-session) | reads `agent/out/fixqueue.json`, fixes, opens PRs with GH_TOKEN | when queue non-empty | 0 |

GitHub Actions budget: private repo free = 2,000 min/mo; projected ≈ 880 min/mo.
Cloudflare free: 100k req/day worker, 1 KV namespace (shared by all fleet members).

## Distribution (no ad spend)

1. GitHub as channel: public `usdt-paykit` quickstart repo + profile README → search traffic.
2. SEO Pages site (`krishna2500.github.io`): USDT/TRC-20 explainer posts → shop links.
3. Clone niches: each new property targets a different long-tail ("accept USDT", "bounty
   scanner", "crypto invoice API") — all funnel to the same verified checkout.
4. Telegram digest doubles as public proof channel (owner may repost; owner work = 0 is
   the standing contract).

## Off-limits (hard)

Owner capital before first revenue · fake identity/romance · captcha automation ·
mass account creation or spam farms (ban risk) · mining on free clouds · self-replication
outside this infrastructure (clones only via `config.fleet.plan`, capped by `maxClones`).

## Trigger ladder

```
$0      → channels 1–4 armed, scout 30-min, fix queue live
$5      → fleet clone #1 (usdt-payment-kit)
$15     → clone #2, reinvest 50% into listing/distribution assets only
$50     → clone #3 + revisit paid ads (reinvest bucket only, never owner capital)
```
