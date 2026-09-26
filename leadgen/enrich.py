#!/usr/bin/env python3
"""
Lead Enrichment - LLM scoring + free API enrichment
Uses Groq (free, fast) for scoring and personalization
"""

import os
import json
import requests
from typing import List, Dict, Any
from datetime import datetime

from db import get_conn, get_leads_for_site_gen, update_lead_status
from groq import Groq

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
HUNTER_API_KEY = os.getenv("HUNTER_API_KEY")
APOLLO_API_KEY = os.getenv("APOLLO_API_KEY")

client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


def enrich_with_hunter(domain: str) -> List[Dict]:
    """Hunter.io - 25 free requests/month"""
    if not HUNTER_API_KEY or not domain:
        return []
    
    try:
        r = requests.get(
            f"https://api.hunter.io/v2/domain-search",
            params={"domain": domain, "api_key": HUNTER_API_KEY, "limit": 10},
            timeout=10
        )
        if r.ok:
            data = r.json()
            emails = []
            for email_data in data.get("data", {}).get("emails", []):
                emails.append({
                    "email": email_data.get("value"),
                    "name": f"{email_data.get('first_name', '')} {email_data.get('last_name', '')}".strip(),
                    "role": email_data.get("position", ""),
                    "source": "hunter",
                    "confidence": email_data.get("confidence", 50),
                    "verified": email_data.get("status") == "valid"
                })
            return emails
    except Exception as e:
        print(f"Hunter error for {domain}: {e}")
    return []


def enrich_with_apollo(domain: str) -> List[Dict]:
    """Apollo.io - 50 free requests/month"""
    if not APOLLO_API_KEY or not domain:
        return []
    
    try:
        r = requests.post(
            "https://api.apollo.io/v1/mixed_companies/search",
            headers={"Authorization": f"Bearer {APOLLO_API_KEY}", "Content-Type": "application/json"},
            json={"q_organization_domains": domain, "page": 1, "per_page": 10},
            timeout=10
        )
        if r.ok:
            data = r.json()
            contacts = []
            for org in data.get("organizations", []):
                for person in org.get("people", []):
                    contacts.append({
                        "email": person.get("email"),
                        "name": person.get("name"),
                        "role": person.get("title"),
                        "source": "apollo",
                        "confidence": 80,
                        "verified": bool(person.get("email"))
                    })
            return contacts
    except Exception as e:
        print(f"Apollo error for {domain}: {e}")
    return []


def llm_score_and_personalize(lead: Dict) -> Dict:
    """Use Groq LLM to score lead and generate personalized angle"""
    if not client:
        return {"score": 50, "pain_points": [], "outreach_angle": "Security assessment for your stack"}
    
    prompt = f"""
You are a senior security consultant evaluating a lead for outreach.

Company: {lead.get('company')}
Website: {lead.get('website')}
Domain: {lead.get('domain')}
Tech Stack: {json.dumps(lead.get('tech_stack', []))}
Funding: {json.dumps(lead.get('funding_info', {}))}
Hiring Signals: {json.dumps(lead.get('hiring_signals', []))}
Source: {lead.get('source')}

Score this lead 0-100 for likelihood to need AND pay for security services (penetration testing, code review, bug bounty management, security architecture review).

Consider:
- Tech stack risk (JS/Python/Go/Java = higher, static sites = lower)
- Funding stage (Series A+ = budget, seed = maybe, pre-seed = low)
- Hiring security roles = active pain + budget
- Company size signals
- Source credibility (Crunchbase > GitHub > job board > TechCrunch)

Output ONLY valid JSON:
{{
  "score": 0-100,
  "reasoning": "brief reason",
  "pain_points": ["specific pain 1", "pain 2"],
  "outreach_angle": "personalized hook for cold email",
  "competitor_example": "relevant competitor or similar company"
}}
"""
    
    try:
        response = client.chat.completions.create(
            model="llama-3.1-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=500
        )
        content = response.choices[0].message.content.strip()
        # Extract JSON
        start = content.find("{")
        end = content.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(content[start:end])
    except Exception as e:
        print(f"LLM error for {lead.get('company')}: {e}")
    
    return {"score": 50, "pain_points": [], "outreach_angle": f"Security review for {lead.get('company')}"}


def enrich_leads(db_path, new_leads: List[Dict]) -> List[Dict]:
    """Enrich leads with contacts, scoring, and personalization"""
    enriched = []
    
    for lead in new_leads:
        domain = lead.get('domain')
        company = lead.get('company')
        
        print(f"  Enriching: {company} ({domain})")
        
        # 1. Find contacts
        contacts = []
        if domain:
            contacts.extend(enrich_with_hunter(domain))
            contacts.extend(enrich_with_apollo(domain))
        
        # 2. LLM scoring
        enrichment = llm_score_and_personalize(lead)
        
        # 3. Update lead with enrichment
        lead['score'] = enrichment.get('score', 50)
        lead['pain_points'] = enrichment.get('pain_points', [])
        lead['outreach_angle'] = enrichment.get('outreach_angle', '')
        lead['status'] = 'enriched'
        
        # Save to DB
        with get_conn(db_path) as conn:
            lead_id = upsert_lead(conn, lead)
            
            for contact in contacts:
                # Check if contact already exists
                existing = conn.execute(
                    "SELECT id FROM contacts WHERE lead_id = ? AND email = ?", (lead_id, contact['email'])
                ).fetchone()
                if not existing and contact.get('email'):
                    add_contact(conn, lead_id, contact)
            
            conn.commit()
        
        enriched.append(lead)
    
    return enriched


def upsert_lead(conn, lead: Dict) -> int:
    """Insert or update lead, return lead_id"""
    cursor = conn.execute(
        """INSERT INTO leads (source, company, website, domain, tech_stack, funding_info, 
               hiring_signals, raw_data, score, pain_points, outreach_angle, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(company, source) DO UPDATE SET
               website=excluded.website, domain=excluded.domain, tech_stack=excluded.tech_stack,
               funding_info=excluded.funding_info, hiring_signals=excluded.hiring_signals,
               raw_data=excluded.raw_data, score=excluded.score, pain_points=excluded.pain_points,
               outreach_angle=excluded.outreach_angle, status=excluded.status, updated_at=CURRENT_TIMESTAMP
           RETURNING id""",
        (lead.get('source'), lead.get('company'), lead.get('website'),
         lead.get('domain'), json.dumps(lead.get('tech_stack', [])),
         json.dumps(lead.get('funding_info', {})), json.dumps(lead.get('hiring_signals', [])),
         json.dumps(lead.get('raw_data', {})), lead.get('score', 0),
         json.dumps(lead.get('pain_points', [])), lead.get('outreach_angle'),
         lead.get('status', 'new'))
    )
    return cursor.fetchone()[0]


def add_contact(conn, lead_id: int, contact: Dict):
    conn.execute(
        """INSERT OR IGNORE INTO contacts (lead_id, email, name, role, source, verified, confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (lead_id, contact.get('email'), contact.get('name'),
         contact.get('role'), contact.get('source'),
         contact.get('verified', False), contact.get('confidence', 0))
    )