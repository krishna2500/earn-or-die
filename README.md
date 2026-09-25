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
| `bounties` | 🟢 scouting | Scouts open-source bounties (GitHub `bounty` label + Algora). Agent solves, PRs, gets paid in crypto/cash. |
| `content` | 🟡 research | SEO/affiliate sites. 2026 lesson: thin AI content gets crushed — only topical-depth content with editorial layer ships. |
| `products` | 🟡 awaiting key | Micro-products with crypto checkout (USDT TRC-20) on free infrastructure. Needs CryptoBot API key. |

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
