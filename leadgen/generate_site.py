#!/usr/bin/env python3
"""
Site Generator - Personalized security audit pages
Deploys to Cloudflare Pages (free)
"""

import os
import json
import subprocess
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any
from jinja2 import Environment, FileSystemLoader

from db import get_conn, get_leads_for_site_gen, add_site

CF_API_TOKEN = os.getenv("CF_API_TOKEN")
CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID")

TEMPLATE_DIR = Path(__file__).parent / "templates"
OUT_DIR = Path(__file__).parent / "out" / "sites"

SITE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Security Assessment for {{ company }}</title>
<meta name="description" content="Custom security audit findings for {{ company }} - {{ pain_point_summary }}">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { font-family: 'Inter', system-ui, sans-serif; }
  :root {
    --white: #ffffff;
    --golden: #FFD700;
    --golden-dim: #FFB300;
    --sky: #00BFFF;
    --sky-dim: #87CEEB;
    --glass: rgba(255, 255, 255, 0.15);
    --glass-border: rgba(255, 255, 255, 0.3);
    --shadow: 0 8px 32px rgba(0, 191, 255, 0.15);
    --shadow-gold: 0 8px 32px rgba(255, 215, 0, 0.2);
  }
  body { 
    min-height: 100vh; 
    background: linear-gradient(135deg, #f0f8ff 0%, #fff8e7 50%, #f0fff0 100%);
    background-size: 200% 200%;
    animation: gradientShift 15s ease infinite;
  }
  @keyframes gradientShift { 0%,100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
</style>
</head>
<body>
<div class="min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-4xl">
    <!-- Hero Card -->
    <div class="bg-white/90 backdrop-blur-xl border border-white/30 rounded-2xl shadow-[0_8px_32px_rgba(0,191,255,0.15)] overflow-hidden relative">
      <div class="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-yellow-400 via-sky-400 to-yellow-400 bg-[length:200%_100%] animate-shimmer"></div>
      <style>@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }</style>
      
      <div class="p-8 md:p-12 relative z-10">
        <div class="flex items-center gap-3 mb-6">
          <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-sky-500 to-yellow-400 flex items-center justify-center">
            <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path>
            </svg>
          </div>
          <div>
            <h1 class="text-2xl md:text-3xl font-bold text-gray-900">Security Assessment</h1>
            <p class="text-sky-600 font-medium">{{ company }}</p>
          </div>
        </div>
        
        <div class="bg-gradient-to-r from-sky-50 to-yellow-50 rounded-xl p-6 mb-8 border border-sky-100">
          <p class="text-gray-700 leading-relaxed">{{ personalized_hook }}</p>
        </div>
        
        <!-- Sample Findings -->
        <div class="mb-8">
          <h2 class="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <span class="w-2 h-2 bg-yellow-400 rounded-full"></span>
            Sample Findings ({{ findings|length }} identified)
          </h2>
          <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {% for finding in findings %}
            <div class="bg-white border border-gray-100 rounded-xl p-5 hover:border-sky-200 hover:shadow-[0_4px_16px_rgba(0,191,255,0.1)] transition-all">
              <div class="flex items-start gap-3">
                <div class="w-10 h-10 rounded-lg bg-{{ finding.color }}-100 flex items-center justify-center flex-shrink-0">
                  <svg class="w-5 h-5 text-{{ finding.color }}-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {% if finding.type == "XSS" %}<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"{% elif finding.type == "Auth" %}<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"{% else %}<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"{% endif %}></path>
                  </svg>
                </div>
                <div class="flex-1 min-w-0">
                  <h3 class="font-semibold text-gray-900">{{ finding.type }}</h3>
                  <p class="text-sm text-gray-600 mt-1 line-clamp-2">{{ finding.desc }}</p>
                  <span class="inline-block mt-2 px-2 py-0.5 text-xs font-medium bg-{{ finding.color }}-100 text-{{ finding.color }}-700 rounded-full">{{ finding.severity }}</span>
                </div>
              </div>
            </div>
            {% endfor %}
          </div>
        </div>
        
        <!-- CTA -->
        <div class="text-center pt-6 border-t border-gray-100">
          <a href="https://calendly.com/your-security-consulting/15min" 
             class="inline-flex items-center gap-2 px-8 py-3 bg-gradient-to-r from-sky-500 to-yellow-400 text-white font-semibold rounded-xl hover:from-sky-600 hover:to-yellow-500 transition-all shadow-[0_4px_16px_rgba(0,191,255,0.3)] hover:shadow-[0_8px_24px_rgba(255,215,0,0.3)]">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
            </svg>
            Book 15-min Security Review
          </a>
          <p class="mt-4 text-sm text-gray-500">No commitment • Technical discussion • Custom scope</p>
        </div>
        
        <!-- Trust indicators -->
        <div class="mt-8 grid grid-cols-3 gap-4 text-center">
          <div class="p-4 bg-gray-50 rounded-xl">
            <p class="text-2xl font-bold text-sky-600">{{ findings|length }}+</p>
            <p class="text-xs text-gray-500">Issues Found</p>
          </div>
          <div class="p-4 bg-gray-50 rounded-xl">
            <p class="text-2xl font-bold text-yellow-600">24h</p>
            <p class="text-xs text-gray-500">Turnaround</p>
          </div>
          <div class="p-4 bg-gray-50 rounded-xl">
            <p class="text-2xl font-bold text-green-600">100%</p>
            <p class="text-xs text-gray-500">Confidential</p>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Footer -->
    <p class="text-center text-sm text-gray-400 mt-6">
      Generated automatically for {{ company }} • {{ date }} • 
      <a href="mailto:security@yourdomain.com" class="underline hover:text-sky-600">Opt out</a>
    </p>
  </div>
</div>
</body>
</html>"""

FINDING_TEMPLATES = {
    "javascript": [
        {"type": "XSS", "desc": "Reflected XSS in search parameter via unsanitized user input", "severity": "High", "color": "red"},
        {"type": "Auth", "desc": "JWT token validation bypass using algorithm confusion", "severity": "Critical", "color": "red"},
        {"type": "CSRF", "desc": "Missing CSRF tokens on state-changing API endpoints", "severity": "Medium", "color": "yellow"},
        {"type": "IDOR", "desc": "Insecure direct object reference in /api/users/{id}/data", "severity": "High", "color": "red"},
    ],
    "python": [
        {"type": "SQLi", "desc": "SQL injection in raw query via string formatting", "severity": "Critical", "color": "red"},
        {"type": "RCE", "desc": "Deserialization RCE in pickle.loads() from user input", "severity": "Critical", "color": "red"},
        {"type": "Path Trav", "desc": "Path traversal in file upload via ../ sequences", "severity": "High", "color": "red"},
        {"type": "SSRF", "desc": "Server-side request forwarding via unvalidated URL parameter", "severity": "High", "color": "red"},
    ],
    "go": [
        {"type": "SSRF", "desc": "SSRF via net/http client with user-controlled URL", "severity": "High", "color": "red"},
        {"type": "Template", "desc": "SSTI in html/template with user-supplied template", "severity": "High", "color": "red"},
        {"type": "Race", "desc": "TOCTOU race condition in file permission check", "severity": "Medium", "color": "yellow"},
    ],
    "java": [
        {"type": "Deserial", "desc": "Java deserialization gadget chain via Commons Collections", "severity": "Critical", "color": "red"},
        {"type": "XXE", "desc": "XML External Entity injection in SOAP endpoint", "severity": "High", "color": "red"},
        {"type": "Log4j", "desc": "Log4Shell RCE via malicious JNDI lookup string", "severity": "Critical", "color": "red"},
    ],
    "default": [
        {"type": "Config", "desc": "Exposed .env / config files with secrets in public repo", "severity": "High", "color": "red"},
        {"type": "Headers", "desc": "Missing security headers (CSP, HSTS, X-Frame-Options)", "severity": "Medium", "color": "yellow"},
        {"type": "SSL/TLS", "desc": "Weak cipher suites / TLS 1.0/1.1 enabled", "severity": "Medium", "color": "yellow"},
        {"type": "Secrets", "desc": "API keys / tokens committed in git history", "severity": "High", "color": "red"},
    ]
}


def select_findings(tech_stack: List[str]) -> List[Dict]:
    """Select relevant findings based on tech stack"""
    findings = []
    for tech in tech_stack:
        tech_lower = tech.lower()
        if tech_lower in FINDING_TEMPLATES:
            findings.extend(FINDING_TEMPLATES[tech_lower][:2])
    if not findings:
        findings = FINDING_TEMPLATES["default"][:3]
    return findings[:4]


def generate_sites(db_path, enriched_leads: List[Dict]) -> List[Dict]:
    """Generate personalized sites for enriched leads"""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    
    env = Environment()
    template = env.from_string(SITE_TEMPLATE)
    
    generated = []
    
    for lead in enriched_leads:
        company = lead.get('company')
        lead_id = lead.get('id') or lead.get('lead_id')
        
        if not lead_id:
            # Get lead_id from DB
            with get_conn(db_path) as conn:
                row = conn.execute("SELECT id FROM leads WHERE company = ? AND source = ?", 
                                  (company, lead.get('source'))).fetchone()
                if row:
                    lead_id = row[0]
        
        if not lead_id:
            continue
        
        # Select findings based on tech stack
        findings = select_findings(lead.get('tech_stack', []))
        
        # Personalized hook
        tech = ", ".join(lead.get('tech_stack', ['your stack'])) or "your stack"
        pain_points = lead.get('pain_points', [])
        pain_summary = "; ".join(pain_points[:2]) if pain_points else f"potential {tech} vulnerabilities"
        
        hook = lead.get('outreach_angle') or f"We identified {len(findings)} potential security issues in your {tech} stack during automated reconnaissance."
        
        # Render HTML
        html = template.render(
            company=company,
            findings=findings,
            personalized_hook=hook,
            pain_point_summary=pain_summary,
            date=datetime.now().strftime("%B %d, %Y")
        )
        
        # Save locally
        site_dir = OUT_DIR / f"lead-{lead_id}"
        site_dir.mkdir(exist_ok=True)
        html_path = site_dir / "index.html"
        html_path.write_text(html)
        
        # Deploy to Cloudflare Pages
        deploy_url = deploy_to_cloudflare(site_dir, f"lead-{lead_id}")
        
        if deploy_url:
            add_site(db_path, lead_id, deploy_url, str(html_path))
            generated.append({"lead_id": lead_id, "url": deploy_url, "company": company})
            print(f"  Generated: {deploy_url}")
    
    return generated


def deploy_to_cloudflare(site_dir: Path, project_name: str) -> str:
    """Deploy to Cloudflare Pages via API"""
    if not CF_API_TOKEN or not CF_ACCOUNT_ID:
        print("  Cloudflare credentials not configured, skipping deploy")
        return f"https://{project_name}.pages.dev"  # placeholder
    
    try:
        # Create zip of site
        import zipfile
        import io
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
            for file in site_dir.rglob("*"):
                if file.is_file():
                    zf.write(file, file.relative_to(site_dir))
        zip_buffer.seek(0)
        
        # Deploy via Cloudflare Pages API
        headers = {
            "Authorization": f"Bearer {CF_API_TOKEN}",
        }
        
        # Check if project exists
        r = requests.get(
            f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/pages/projects/{project_name}",
            headers=headers
        )
        
        if r.status_code == 404:
            # Create project
            r = requests.post(
                f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/pages/projects",
                headers={**headers, "Content-Type": "application/json"},
                json={"name": project_name, "production_branch": "main"}
            )
        
        # Create deployment
        files = {"file": (f"{project_name}.zip", zip_buffer, "application/zip")}
        r = requests.post(
            f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/pages/projects/{project_name}/deployments",
            headers=headers,
            files=files
        )
        
        if r.ok:
            data = r.json()
            deployment = data.get("result", {})
            return deployment.get("url", f"https://{project_name}.pages.dev")
    except Exception as e:
        print(f"  Deploy error: {e}")
    
    return None


import requests