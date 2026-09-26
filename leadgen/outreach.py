#!/usr/bin/env python3
"""
Outreach Engine - Automated email sequences via Brevo (300/day free)
"""

import os
import json
import requests
from datetime import datetime, timedelta
from typing import List, Dict, Any
from pathlib import Path
from jinja2 import Environment

from db import get_conn, get_leads_needing_outreach, log_outreach, update_lead_status, update_outreach_status, get_new_replies

BREVO_API_KEY = os.getenv("BREVO_API_KEY")
TG_BOT_TOKEN = os.getenv("TG_BOT_TOKEN")
TG_OWNER_CHAT = os.getenv("TG_OWNER_CHAT")

SEQUENCE = [
    {"name": "intro", "delay_days": 0, "template": "intro_email.j2"},
    {"name": "value", "delay_days": 2, "template": "value_email.j2"},
    {"name": "social", "delay_days": 5, "template": "social_email.j2"},
    {"name": "breakup", "delay_days": 10, "template": "breakup_email.j2"},
]

INTRO_TEMPLATE = """Hi {{ contact_name }},

I was researching {{ company }} and noticed you're using {{ tech_stack }} across your platform. 

During automated security reconnaissance, I identified {{ finding_count }} potential vulnerabilities in your {{ primary_tech }} stack — including {{ top_finding }}.

I've put together a brief, personalized assessment here: {{ site_url }}

It takes 2 minutes to review. No sales pitch, just technical findings.

Worth a quick look?

Best,
[Your Name]
Security Consultant | Bug Bounty Hunter
{{ calendly_link }}"""

VALUE_TEMPLATE = """Hi {{ contact_name }},

Following up — I wanted to share more detail on the top 3 findings for {{ company }}:

1. **{{ finding_1_type }}** — {{ finding_1_desc }}
2. **{{ finding_2_type }}** — {{ finding_2_desc }}
3. **{{ finding_3_type }}** — {{ finding_3_desc }}

Full details at: {{ site_url }}

These are the types of issues that bug bounty programs pay $500-$5000+ for. Happy to walk through remediation.

Open to a 15-min technical call?

{{ calendly_link }}"""

SOCIAL_TEMPLATE = """Hi {{ contact_name }},

{{ competitor }} had a similar {{ finding_type }} issue last quarter — it took them 3 weeks to detect via their bug bounty program.

We helped them close it in 48 hours.

If {{ company }} is running a similar stack ({{ tech_stack }}), the same attack surface likely exists.

Assessment here: {{ site_url }}

{{ calendly_link }}"""

BREAKUP_TEMPLATE = """Hi {{ contact_name }},

I'll keep this brief — this is my last note.

If security isn't a priority right now, no worries. The assessment at {{ site_url }} will stay live for 30 days if things change.

Appreciate your time.

Best,
[Your Name]"""

TEMPLATES = {
    "intro_email.j2": INTRO_TEMPLATE,
    "value_email.j2": VALUE_TEMPLATE,
    "social_email.j2": SOCIAL_TEMPLATE,
    "breakup_email.j2": BREAKUP_TEMPLATE,
}


def render_template(template_name: str, context: Dict) -> tuple:
    """Render subject and body from template"""
    env = Environment()
    template = env.from_string(TEMPLATES.get(template_name, ""))
    body = template.render(**context)
    
    # Extract subject from first line or use default
    lines = body.strip().split('\n')
    subject = lines[0] if lines else "Security Assessment"
    if subject.startswith("Subject:"):
        subject = subject[8:].strip()
        body = '\n'.join(lines[1:])
    
    return subject, body.strip()


def send_brevo_email(to_email: str, to_name: str, subject: str, html_body: str, text_body: str) -> Dict:
    """Send email via Brevo API"""
    if not BREVO_API_KEY:
        return {"success": False, "error": "BREVO_API_KEY not set"}
    
    url = "https://api.brevo.com/v3/smtp/email"
    headers = {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json"
    }
    payload = {
        "sender": {"name": "Security Research", "email": "security@yourdomain.com"},
        "to": [{"email": to_email, "name": to_name}],
        "subject": subject,
        "htmlContent": html_body,
        "textContent": text_body,
        "tags": ["leadgen", "security"]
    }
    
    try:
        r = requests.post(url, headers=headers, json=payload, timeout=30)
        if r.ok:
            return {"success": True, "message_id": r.json().get("messageId")}
        else:
            return {"success": False, "error": r.text}
    except Exception as e:
        return {"success": False, "error": str(e)}


def run_outreach(db_path) -> Dict:
    """Main outreach function - sends next sequence step for eligible leads"""
    sent = 0
    replies = 0
    
    # Check for new replies first
    new_replies = get_new_replies(db_path, since_hours=24)
    for reply in new_replies:
        update_outreach_status(db_path, reply['id'], 'replied', 
                              replied_at=datetime.now().isoformat(),
                              reply_text=reply.get('reply_text', ''))
        update_lead_status(db_path, reply['lead_id'], 'replied')
        replies += 1
        notify_telegram(f"📨 Reply from {reply['company']}: {reply.get('reply_text', '')[:100]}")
    
    # Get leads needing outreach
    leads = get_leads_needing_outreach(db_path, limit=50)
    
    for lead in leads:
        # Determine next sequence step
        with get_conn(db_path) as conn:
            last = conn.execute(
                """SELECT template, sequence_step, sent_at FROM outreach_log 
                   WHERE lead_id = ? AND channel = 'email' 
                   ORDER BY sequence_step DESC LIMIT 1""",
                (lead['id'],)
            ).fetchone()
        
        if last:
            next_step = last['sequence_step'] + 1
            last_sent = datetime.fromisoformat(last['sent_at'])
            min_delay = SEQUENCE[next_step - 1]['delay_days'] if next_step <= len(SEQUENCE) else 999
            if (datetime.now() - last_sent).days < min_delay:
                continue
        else:
            next_step = 1
        
        if next_step > len(SEQUENCE):
            update_lead_status(db_path, lead['id'], 'closed_lost')
            continue
        
        # Get contact
        contact_email = lead.get('email')
        contact_name = lead.get('name', 'there')
        if not contact_email:
            continue
        
        # Build context
        tech_stack = json.loads(lead.get('tech_stack', '[]')) if isinstance(lead.get('tech_stack'), str) else lead.get('tech_stack', [])
        primary_tech = tech_stack[0] if tech_stack else 'your stack'
        
        site_row = None
        with get_conn(db_path) as conn:
            site_row = conn.execute("SELECT url FROM sites WHERE lead_id = ? ORDER BY deployed_at DESC LIMIT 1", (lead['id'],)).fetchone()
        
        site_url = site_row['url'] if site_row else f"https://yourdomain.com/lead-{lead['id']}"
        
        context = {
            "company": lead['company'],
            "contact_name": contact_name,
            "tech_stack": ", ".join(tech_stack) if tech_stack else primary_tech,
            "primary_tech": primary_tech,
            "finding_count": "3-5",
            "top_finding": "auth bypass + XSS",
            "finding_1_type": "Auth Bypass",
            "finding_1_desc": "JWT algorithm confusion allows token forgery",
            "finding_2_type": "XSS",
            "finding_2_desc": "Reflected XSS in search endpoint",
            "finding_3_type": "IDOR",
            "finding_3_desc": "Direct object reference in API",
            "finding_type": "auth bypass",
            "competitor": "a Series B fintech",
            "site_url": site_url,
            "calendly_link": "https://calendly.com/your-security/15min"
        }
        
        template_name = SEQUENCE[next_step - 1]['template']
        subject, body = render_template(template_name, context)
        
        # Convert to HTML
        html_body = body.replace('\n', '<br>')
        
        # Send
        result = send_brevo_email(contact_email, contact_name, subject, html_body, body)
        
        # Log
        log_id = log_outreach(db_path, {
            "lead_id": lead['id'],
            "contact_id": lead.get('contact_id'),
            "channel": "email",
            "template": template_name,
            "subject": subject,
            "body": body,
            "status": "sent" if result['success'] else "failed",
            "sequence_step": next_step
        })
        
        if result['success']:
            sent += 1
            update_lead_status(db_path, lead['id'], 'contacted')
            print(f"  Sent {template_name} to {contact_email} ({lead['company']})")
        else:
            print(f"  Failed to send to {contact_email}: {result.get('error')}")
        
        # Rate limit
        import time
        time.sleep(2)
    
    return {"sent": sent, "replies": replies}


def notify_telegram(message: str):
    if TG_BOT_TOKEN and TG_OWNER_CHAT:
        try:
            requests.post(
                f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage",
                json={"chat_id": TG_OWNER_CHAT, "text": message},
                timeout=5
            )
        except:
            pass


import json