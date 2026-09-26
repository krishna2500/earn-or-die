# GitHub Secrets Required for earn-or-die Automation

## Required Secrets (Settings → Secrets → Actions)

### Core Agent
| Secret | Description | Get From |
|--------|-------------|----------|
| `GH_TOKEN` | GitHub PAT with repo scope | GitHub Settings → Developer Settings |
| `TG_BOT_TOKEN` | Telegram bot token | @BotFather |
| `TG_OWNER_CHAT` | Your Telegram chat ID | @userinfobot |

### Bug Bounty Scan Arm
| Secret | Description | Get From |
|--------|-------------|----------|
| `GROQ_API_KEY` | Free LLM API key | console.groq.com |

### Lead Gen Pipeline
| Secret | Description | Get From |
|--------|-------------|----------|
| `GROQ_API_KEY` | (same as above) | console.groq.com |
| `BREVO_API_KEY` | Free email API (300/day) | brevo.com |
| `SUPABASE_URL` | Database URL | supabase.com |
| `SUPABASE_KEY` | Anon/service key | supabase.com |
| `HUNTER_API_KEY` | Email finder (25/mo free) | hunter.io |
| `APOLLO_API_KEY` | Contact enrichment (50/mo) | apollo.io |
| `CF_API_TOKEN` | Cloudflare Pages deploy | dash.cloudflare.com |
| `CF_ACCOUNT_ID` | Cloudflare account ID | dash.cloudflare.com |

### Optional
| Secret | Description | Get From |
|--------|-------------|----------|
| `CRUNCHBASE_API_KEY` | Funding data (50/mo) | crunchbase.com |

---

## Free Tier Limits Summary

| Service | Free Limit | Use Case |
|---------|------------|----------|
| GitHub Actions | 2000 min/mo | All workflows |
| Oracle Cloud | 4 ARM VMs (always free) | 24/7 workers |
| Groq | Unlimited (rate limited) | LLM scoring/triage |
| Brevo | 300 emails/day | Outreach sequences |
| Supabase | 500MB Postgres | Lead database |
| Hunter.io | 25 requests/mo | Email finding |
| Apollo.io | 50 requests/mo | Contact enrichment |
| Cloudflare Pages | Unlimited sites | Personalized audit pages |
| Nuclei templates | Free | Vulnerability scanning |

---

## Quick Setup Commands

```bash
# 1. Push workflows to GitHub
git add .github/workflows/agent.yml .github/workflows/leadgen.yml .github/workflows/scout.yml
git add agent/arms/scan.mjs agent/arms/scan.py config.json
git add leadgen/
git commit -m "feat: add scan arm + leadgen pipeline"
git push

# 2. Add secrets in GitHub UI (Settings → Secrets → Actions)
# 3. Enable Actions on repo
# 4. Trigger manually first run via Actions tab
```

---

## Workflow Schedule

| Workflow | Cron | Purpose |
|----------|------|---------|
| `agent.yml` | `17 */6 * * *` (every 6h at :17) | Full agent cycle: bounties → scan → think → act → grow |
| `scout.yml` | `*/30 * * * *` (every 30 min) | Fast bounty discovery only |
| `leadgen.yml` | `0 */6 * * *` (every 6h at :00) | Lead discovery → enrich → sites → outreach |

---

## Expected Outputs (per cycle)

### Agent (bug bounty)
- `out/bounties.json` — Fresh bounty opportunities
- `out/fixqueue.json` — Issues ready for PR fixing
- `out/scan_findings.json` — Nuclei + LLM triaged vulns
- `out/scan_report.md` — Human-readable actionable findings
- Telegram alert for new actionable findings

### Lead Gen
- `leadgen/out/summary.json` — Pipeline stats
- `leadgen/out/leads.db` — SQLite with all leads/contacts/sites/outreach
- `leadgen/out/sites/lead-{id}/index.html` — Personalized audit pages
- Deployed to `https://lead-{id}.pages.dev`
- Telegram alert for new replies