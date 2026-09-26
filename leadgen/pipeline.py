#!/usr/bin/env python3
"""
Lead Gen Pipeline - Zero-cost automated outreach
Runs via GitHub Actions every 6 hours
"""

import os
import sys
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timedelta

sys.path.insert(0, str(Path(__file__).parent))

from discover import discover_leads
from enrich import enrich_leads
from generate_site import generate_sites
from outreach import run_outreach
from db import init_db, get_leads_needing_outreach, get_new_replies


def main():
    print(f"[{datetime.now().isoformat()}] Starting lead-gen pipeline")
    
    # Initialize database
    db_path = Path(__file__).parent / "out" / "leads.db"
    init_db(db_path)
    
    # 1. DISCOVER - Find new leads
    print("[1/4] Discovering leads...")
    new_leads = discover_leads(db_path)
    print(f"  Found {len(new_leads)} new leads")
    
    # 2. ENRICH - Score and enrich with LLM
    print("[2/4] Enriching leads...")
    enriched = enrich_leads(db_path, new_leads)
    print(f"  Enriched {len(enriched)} leads")
    
    # 3. GENERATE SITES - Create personalized pages
    print("[3/4] Generating personalized sites...")
    sites = generate_sites(db_path, enriched)
    print(f"  Generated {len(sites)} sites")
    
    # 4. OUTREACH - Send email sequences
    print("[4/4] Running outreach sequences...")
    outreach_stats = run_outreach(db_path)
    print(f"  Sent {outreach_stats['sent']} emails, {outreach_stats['replies']} new replies")
    
    # Summary
    summary = {
        "run_at": datetime.now().isoformat(),
        "new_leads": len(new_leads),
        "enriched": len(enriched),
        "sites_generated": len(sites),
        "emails_sent": outreach_stats['sent'],
        "new_replies": outreach_stats['replies']
    }
    
    out_dir = Path(__file__).parent / "out"
    out_dir.mkdir(exist_ok=True)
    with open(out_dir / "summary.json", "w") as f:
        json.dump(summary, f, indent=2)
    
    print(f"[{datetime.now().isoformat()}] Pipeline complete: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())