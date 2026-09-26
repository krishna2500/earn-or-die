#!/usr/bin/env python3
"""
Lead Discovery - Multi-source free lead finding
Sources: GitHub, Y Combinator, Crunchbase, Wellfound, Job boards, TechCrunch
"""

import os
import json
import re
import requests
from datetime import datetime, timedelta
from typing import List, Dict, Any
from urllib.parse import urlparse

from db import upsert_lead, get_conn


GITHUB_TOKEN = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")


def github_search(query: str, per_page: int = 100) -> List[Dict]:
    """Search GitHub issues/repos"""
    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    
    url = f"https://api.github.com/search/issues?q={requests.utils.quote(query)}&per_page={per_page}"
    r = requests.get(url, headers=headers, timeout=30)
    if not r.ok:
        return []
    return r.json().get("items", [])


def github_repo_info(owner: str, repo: str) -> Dict:
    headers = {"Accept": "application/vnd.github+json"}
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    r = requests.get(f"https://api.github.com/repos/{owner}/{repo}", headers=headers, timeout=10)
    return r.json() if r.ok else {}


def discover_github_leads() -> List[Dict]:
    """Find companies with security-relevant signals on GitHub"""
    leads = []
    
    queries = [
        # Companies with security issues, old dependencies, etc.
        'language:javascript stars:>100 "security" "vulnerability" is:issue is:open',
        'language:python stars:>100 "dependabot" "security" is:issue is:open',
        'language:go stars:>100 "CVE" is:issue is:open',
        # Companies hiring security
        'org:hiring "security engineer" OR "application security" OR "penetration tester"',
        # Tech stacks that indicate security needs
        'language:typescript "auth" "bypass" is:issue is:open',
        'language:java "sql injection" is:issue is:open',
    ]
    
    for query in queries:
        try:
            items = github_search(query)
            for item in items[:20]:
                repo_url = item.get("repository_url", "")
                if not repo_url:
                    continue
                repo = repo_url.replace("https://api.github.com/repos/", "")
                owner, repo_name = repo.split("/")[:2]
                
                meta = github_repo_info(owner, repo_name)
                if not meta or meta.get("archived") or meta.get("disabled"):
                    continue
                
                # Skip personal/small projects
                if meta.get("stargazers_count", 0) < 50:
                    continue
                
                company = owner
                website = meta.get("homepage") or f"https://github.com/{owner}"
                
                leads.append({
                    "source": "github",
                    "company": company,
                    "website": website,
                    "domain": extract_domain(website),
                    "tech_stack": [meta.get("language", "").lower()] if meta.get("language") else [],
                    "funding_info": {},
                    "hiring_signals": [],
                    "raw_data": {
                        "repo": repo,
                        "stars": meta.get("stargazers_count"),
                        "forks": meta.get("forks_count"),
                        "issue_title": item.get("title"),
                        "issue_url": item.get("html_url"),
                    },
                    "score": 0,
                    "pain_points": [],
                    "outreach_angle": "",
                    "status": "new"
                })
        except Exception as e:
            print(f"GitHub search error: {e}")
    
    return leads


def discover_yc_leads() -> List[Dict]:
    """Find recent YC companies (public directory)"""
    leads = []
    try:
        # YC public API / directory
        r = requests.get("https://www.ycombinator.com/companies", timeout=30)
        if r.ok:
            # Parse HTML for company data (simplified)
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(r.text, 'html.parser')
            # YC directory structure - would need actual parsing
            pass
    except Exception as e:
        print(f"YC discovery error: {e}")
    return leads


def discover_crunchbase_leads() -> List[Dict]:
    """Crunchbase free API (50/month) - recently funded Series A+"""
    leads = []
    api_key = os.getenv("CRUNCHBASE_API_KEY")
    if not api_key:
        return leads
    
    try:
        # Search for recently funded security-relevant companies
        url = "https://api.crunchbase.com/v4/searches/organizations"
        headers = {"X-cb-user-key": api_key, "Content-Type": "application/json"}
        payload = {
            "field_ids": ["identifier", "short_description", "website_url", "linkedin", "num_employees_enum",
                         "categories", "funding_stage", "last_funding_at", "last_funding_total"],
            "query": [
                {"type": "predicate", "field_id": "last_funding_at", "operator_id": "gte", "values": [
                    (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")
                ]},
                {"type": "predicate", "field_id": "funding_stage", "operator_id": "includes", "values": ["series_a", "series_b", "series_c"]},
                {"type": "predicate", "field_id": "categories", "operator_id": "includes", "values": ["cybersecurity", "security", "devops", "saas", "fintech", "healthcare"]}
            ],
            "limit": 50
        }
        r = requests.post(url, headers=headers, json=payload, timeout=30)
        if r.ok:
            data = r.json()
            for entity in data.get("entities", []):
                props = entity.get("properties", {})
                leads.append({
                    "source": "crunchbase",
                    "company": props.get("identifier", {}).get("value", ""),
                    "website": props.get("website_url", ""),
                    "domain": extract_domain(props.get("website_url", "")),
                    "tech_stack": [],
                    "funding_info": {
                        "stage": props.get("funding_stage"),
                        "last_funding_at": props.get("last_funding_at"),
                        "last_funding_total": props.get("last_funding_total")
                    },
                    "hiring_signals": [],
                    "raw_data": props,
                    "score": 0,
                    "pain_points": [],
                    "outreach_angle": "",
                    "status": "new"
                })
    except Exception as e:
        print(f"Crunchbase error: {e}")
    return leads


def discover_wellfound_leads() -> List[Dict]:
    """Wellfound (AngelList) - companies hiring security roles"""
    leads = []
    try:
        # Wellfound public job search
        # Would need API key or scraping
        pass
    except Exception as e:
        print(f"Wellfound error: {e}")
    return leads


def discover_job_board_leads() -> List[Dict]:
    """Job boards - companies hiring security = budget + pain"""
    leads = []
    # RemoteOK, WeWorkRemotely, etc. have public feeds
    try:
        r = requests.get("https://remoteok.io/api", timeout=30)
        if r.ok:
            jobs = r.json()
            for job in jobs[1:]:  # First is metadata
                if any(kw in str(job).lower() for kw in ["security", "penetration", "appsec", "devsecops", "soc", "compliance"]):
                    company = job.get("company", "")
                    if company:
                        leads.append({
                            "source": "remoteok",
                            "company": company,
                            "website": job.get("company_url", ""),
                            "domain": extract_domain(job.get("company_url", "")),
                            "tech_stack": job.get("tags", []),
                            "funding_info": {},
                            "hiring_signals": [job.get("position", ""), job.get("description", "")[:500]],
                            "raw_data": job,
                            "score": 0,
                            "pain_points": [],
                            "outreach_angle": "",
                            "status": "new"
                        })
    except Exception as e:
        print(f"Job board error: {e}")
    return leads


def discover_techcrunch_leads() -> List[Dict]:
    """TechCrunch RSS - newly funded companies"""
    leads = []
    try:
        r = requests.get("https://techcrunch.com/feed/", timeout=30)
        if r.ok:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(r.content, 'xml')
            for item in soup.find_all('item')[:30]:
                title = item.title.text if item.title else ""
                link = item.link.text if item.link else ""
                desc = item.description.text if item.description else ""
                
                # Look for funding announcements
                if any(kw in title.lower() for kw in ["raises", "funding", "series a", "series b", "seed", "investment"]):
                    # Extract company name (simplified)
                    company = title.split("raises")[0].split("raised")[0].strip()
                    leads.append({
                        "source": "techcrunch",
                        "company": company,
                        "website": link,
                        "domain": extract_domain(link),
                        "tech_stack": [],
                        "funding_info": {"announcement": title, "url": link},
                        "hiring_signals": [],
                        "raw_data": {"title": title, "link": link, "description": desc[:500]},
                        "score": 0,
                        "pain_points": [],
                        "outreach_angle": "",
                        "status": "new"
                    })
    except Exception as e:
        print(f"TechCrunch error: {e}")
    return leads


def extract_domain(url: str) -> str:
    if not url:
        return ""
    try:
        parsed = urlparse(url if url.startswith("http") else "https://" + url)
        domain = parsed.netloc.replace("www.", "")
        return domain
    except:
        return ""


def discover_leads(db_path) -> List[Dict]:
    """Main discovery function - combines all sources"""
    all_leads = []
    
    print("  Discovering from GitHub...")
    all_leads.extend(discover_github_leads())
    
    print("  Discovering from Crunchbase...")
    all_leads.extend(discover_crunchbase_leads())
    
    print("  Discovering from job boards...")
    all_leads.extend(discover_job_board_leads())
    
    print("  Discovering from TechCrunch...")
    all_leads.extend(discover_techcrunch_leads())
    
    # Deduplicate by company+source
    seen = set()
    unique_leads = []
    for lead in all_leads:
        key = (lead['company'].lower(), lead['source'])
        if key not in seen and lead['company']:
            seen.add(key)
            unique_leads.append(lead)
    
    # Save to database
    saved = 0
    for lead in unique_leads:
        try:
            upsert_lead(db_path, lead)
            saved += 1
        except Exception as e:
            print(f"  DB error for {lead['company']}: {e}")
    
    print(f"  Saved {saved} new leads to database")
    return unique_leads