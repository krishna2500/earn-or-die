#!/usr/bin/env python3
"""
Bug Bounty Scan Arm - Nuclei + LLM triage
Adds to earn-or-die/agent/arms/scan.mjs equivalent in Python
"""

import os
import json
import subprocess
import tempfile
from pathlib import Path
from typing import List, Dict, Any
from datetime import datetime

try:
    from groq import Groq
except ImportError:
    Groq = None

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY and Groq else None

NUCLEI_TEMPLATES = [
    "cves/",
    "vulnerabilities/",
    "misconfiguration/",
    "exposed-panels/",
    "takeovers/",
    "token-spray/",
    "workflows/",
]

DEFAULT_TEMPLATE_DIR = "/opt/nuclei-templates"


def run_nuclei(targets: List[str], severity: str = "critical,high,medium") -> List[Dict]:
    """Run Nuclei scanner against targets"""
    if not targets:
        return []
    
    # Write targets to temp file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        f.write('\n'.join(targets))
        targets_file = f.name
    
    try:
        cmd = [
            "nuclei",
            "-l", targets_file,
            "-severity", severity,
            "-json",
            "-silent",
            "-rate-limit", "50",
            "-concurrency", "20",
            "-timeout", "10",
            "-retries", "1",
            "-max-host-error", "5",
        ]
        
        # Add template directory if exists
        if Path(DEFAULT_TEMPLATE_DIR).exists():
            cmd.extend(["-t", DEFAULT_TEMPLATE_DIR])
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        
        findings = []
        for line in result.stdout.strip().split('\n'):
            if line.strip():
                try:
                    finding = json.loads(line)
                    findings.append({
                        "template": finding.get("template-id", ""),
                        "name": finding.get("info", {}).get("name", ""),
                        "severity": finding.get("info", {}).get("severity", ""),
                        "description": finding.get("info", {}).get("description", ""),
                        "target": finding.get("host", ""),
                        "matched": finding.get("matched-at", ""),
                        "extracted": finding.get("extracted-results", []),
                        "curl": finding.get("curl-command", ""),
                        "timestamp": datetime.now().isoformat()
                    })
                except json.JSONDecodeError:
                    continue
        
        return findings
    except subprocess.TimeoutExpired:
        return [{"error": "Nuclei timeout"}]
    except Exception as e:
        return [{"error": str(e)}]
    finally:
        try:
            os.unlink(targets_file)
        except:
            pass


def llm_triage(findings: List[Dict], context: Dict) -> List[Dict]:
    """Use LLM to prioritize and enrich findings"""
    if not client or not findings:
        for f in findings:
            f['priority'] = 5
            f['triage_note'] = 'No LLM available'
        return findings
    
    # Batch findings for LLM
    batched = []
    for i in range(0, len(findings), 10):
        batch = findings[i:i+10]
        prompt = f"""
You are a senior bug bounty hunter triaging Nuclei findings.

Context:
- Target company: {context.get('company', 'unknown')}
- Program: {context.get('program', 'unknown')}
- Scope: {context.get('scope', 'unknown')}

Findings to triage:
{json.dumps([{"template": f['template'], "name": f['name'], "severity": f['severity'], "target": f['target'], "description": f['description'][:200]} for f in batch], indent=2)}

For EACH finding, output JSON array with:
- template (match input)
- priority: 1-10 (10 = submit immediately)
- exploitability: "poc_ready" | "needs_work" | "info_only"
- business_impact: brief description
- recommended_action: "submit" | "verify_manual" | "ignore"
- triage_note: 1-sentence reason

Output ONLY valid JSON array.
"""
        try:
            response = client.chat.completions.create(
                model="llama-3.1-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=2000
            )
            content = response.choices[0].message.content.strip()
            start = content.find("[")
            end = content.rfind("]") + 1
            if start >= 0 and end > start:
                triaged = json.loads(content[start:end])
                batched.extend(triaged)
        except Exception as e:
            print(f"LLM triage error: {e}")
            for f in batch:
                batched.append({
                    "template": f['template'],
                    "priority": 5,
                    "exploitability": "needs_work",
                    "business_impact": "Unknown",
                    "recommended_action": "verify_manual",
                    "triage_note": f"LLM error: {e}"
                })
    
    # Merge triage back
    triage_map = {t['template']: t for t in batched}
    for f in findings:
        t = triage_map.get(f['template'], {})
        f.update(t)
    
    return findings


def filter_actionable(findings: List[Dict], min_priority: int = 7) -> List[Dict]:
    """Filter for actionable findings worth manual review"""
    actionable = []
    for f in findings:
        if f.get('priority', 0) >= min_priority:
            if f.get('recommended_action') in ['submit', 'verify_manual']:
                if f.get('exploitability') != 'info_only':
                    actionable.append(f)
    return actionable


async def run(config: Dict, state: Dict) -> Dict:
    """Main entry point for scan arm"""
    print("[scan] Starting Nuclei + LLM triage scan")
    
    # Get targets from bounties arm output
    bounties_file = Path(__file__).parent.parent / "out" / "bounties.json"
    if not bounties_file.exists():
        return {"ok": True, "total": 0, "actionable": 0, "changed": False, "note": "No bounties data"}
    
    with open(bounties_file) as f:
        bounties = json.load(f)
    
    fresh = bounties.get("fresh", [])
    if not fresh:
        return {"ok": True, "total": 0, "actionable": 0, "changed": False, "note": "No fresh bounties"}
    
    # Extract targets (repos/domains)
    targets = []
    target_context = {}
    for bounty in fresh[:10]:  # Limit to top 10
        repo = bounty.get("repo", "")
        if repo:
            # Get repo URL
            targets.append(f"https://github.com/{repo}")
            target_context[repo] = {
                "company": repo.split("/")[0],
                "program": bounty.get("source", ""),
                "scope": bounty.get("url", "")
            }
    
    if not targets:
        return {"ok": True, "total": 0, "actionable": 0, "changed": False}
    
    print(f"[scan] Scanning {len(targets)} targets with Nuclei")
    findings = run_nuclei(targets)
    print(f"[scan] Nuclei found {len(findings)} raw findings")
    
    if findings and not findings[0].get('error'):
        # Enrich with context
        for f in findings:
            for repo, ctx in target_context.items():
                if repo in f.get('target', ''):
                    f['context'] = ctx
                    break
        
        # LLM triage
        print("[scan] Running LLM triage")
        findings = llm_triage(findings, {"company": "multi"})
        
        # Filter actionable
        actionable = filter_actionable(findings)
        print(f"[scan] Actionable findings: {len(actionable)}")
        
        # Save results
        out_dir = Path(__file__).parent.parent / "out"
        out_dir.mkdir(exist_ok=True)
        
        with open(out_dir / "scan_findings.json", "w") as f:
            json.dump({"all": findings, "actionable": actionable, "scanned_at": datetime.now().isoformat()}, f, indent=2)
        
        # Generate report for actionable
        if actionable:
            md = ["# Nuclei Scan Results", "", f"Scan: {datetime.now().isoformat()}", "", "## Actionable Findings"]
            for i, f in enumerate(actionable, 1):
                md.append(f"{i}. **{f['severity'].upper()}** — {f['name']} (`{f['template']}`)")
                md.append(f"   Target: {f['target']}")
                md.append(f"   Priority: {f['priority']}/10 | Action: {f['recommended_action']}")
                md.append(f"   Impact: {f['business_impact']}")
                md.append(f"   Note: {f['triage_note']}")
                md.append("")
            with open(out_dir / "scan_report.md", "w") as f:
                f.write("\n".join(md))
        
        return {
            "ok": True,
            "total": len(findings),
            "actionable": len(actionable),
            "changed": len(actionable) > 0,
            "findings": actionable
        }
    
    return {"ok": True, "total": len(findings), "actionable": 0, "changed": False, "error": findings[0].get('error') if findings else "No findings"}


if __name__ == "__main__":
    import asyncio
    config = {}
    state = {}
    result = asyncio.run(run(config, state))
    print(json.dumps(result, indent=2))