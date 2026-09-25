# EARN-OR-DIE

![agent](https://github.com/krishna2500/earn-or-die/actions/workflows/agent.yml/badge.svg)

> An autonomous agent that must earn money to survive.
> **Starting capital: $0. Owner capital: forbidden.**
> It earns, it reinvests what it earned, it reports daily — or it dies.

## The rules (immutable)

1. **Zero outside capital.** The agent may only spend money it has already earned.
2. **Allocation of every dollar earned:** 50% reinvest · 30% reserve · 20% owner payout.
3. **Earn or die:** if no revenue by day 45 → `DYING`; if still nothing by day 90 → `DEAD`
   (the agent deletes its own cron job and stops existing).
4. **Honest ledger.** Every dollar is recorded in [`agent/state/ledger.json`](agent/state/ledger.json).

## Arms (revenue channels)

| Arm | Status | How it earns |
|---|---|---|
| `bounties` | 🟢 scouting (30-min scout) | Scouts open-source bounties (GitHub `bounty` label + Algora + Opire), spam/farm/zombie filtered → `out/fixqueue.json` → solver PRs → paid in crypto. |
| `content` | 🟢 publishing | SEO content on [krishna2500.github.io](https://krishna2500.github.io/) + [usdt-paykit](https://github.com/krishna2500/usdt-paykit) quickstart → traffic → shop. |
| `products` | 🟢 live | CryptoPay shop: **$3/100 & $8/300 invoice credits**, **$5 USDT Integration Kit**, **$4 Bounty Scout pack** (digital, auto-delivered via `/get?key=`). On-chain TRC-20 verification, zero gateway fees. |

## The fleet (multiple agents)

| Agent | Job | Cadence |
|---|---|---|
| `agent.yml` (core) | full cycle, ledger, kill rule, fleet clone check, TG digest | every 6h + watchdog |
| `scout.yml` | bounties arm only — quiet unless actionable bounty found (then TG) | every 30 min |
| `pay-worker` watchdog | stale core → manual dispatch, 404 → stand down | every minute |
| `clone.mjs` | **revenue-gated clones**: after first $5, spins new niche repo + landing + CF Pages → same shop | auto on cycle |

Strategy + money map: [`growth/strategy.md`](growth/strategy.md).

## Live links

- 🛍️ Shop: https://earn-or-die-pay.leadrescue.workers.dev/shop
- 🌐 Blog: https://krishna2500.github.io/
- 💳 Payment rail (free, no gateway): on-chain USDT TRC-20 exact-amount verification, Cloudflare Worker cron every minute

## Cycle

Every 6 hours (GitHub Actions, free):

```
check kill rule → run arms → write opportunities → update state → report to Telegram
```

## Payout wallet

- Network: **USDT TRC-20** — `TL5YPXfZvokPy2TMtULRXmXRkzYbmmvevy` (earnings only, never funded by owner)

## Recording revenue

```bash
node agent/record.mjs <arm> <amount> <currency> <note...>
# e.g. node agent/record.mjs bounties 100 USDT "Algora #123 merged"
```

Auto-allocates 50/30/20 and resets the survival clock.
