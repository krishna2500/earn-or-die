#!/usr/bin/env python3
"""
Database layer for lead-gen pipeline
Uses SQLite (local) + optional Supabase sync
"""

import sqlite3
import json
import os
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Optional, Any
from contextlib import contextmanager


SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,                    -- github, yc, crunchbase, wellfound, job_board
    company TEXT NOT NULL,
    website TEXT,
    domain TEXT,                             -- extracted domain for email finding
    tech_stack TEXT,                         -- JSON array
    funding_info TEXT,                       -- JSON
    hiring_signals TEXT,                     -- JSON
    raw_data TEXT,                           -- JSON original data
    score INTEGER DEFAULT 0,                 -- 1-10
    pain_points TEXT,                        -- JSON array
    outreach_angle TEXT,                     -- personalized angle
    status TEXT DEFAULT 'new',               -- new, enriched, site_generated, contacted, replied, meeting, closed_won, closed_lost
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company, source)
);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    email TEXT,
    name TEXT,
    role TEXT,
    source TEXT,                             -- hunter, apollo, scrape, guess
    verified BOOLEAN DEFAULT FALSE,
    confidence INTEGER DEFAULT 0,            -- 0-100
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    url TEXT,                                -- Cloudflare Pages URL
    html_path TEXT,                          -- local path
    deployed_at TIMESTAMP,
    visits INTEGER DEFAULT 0,
    unique_visitors INTEGER DEFAULT 0,
    last_visit_at TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE TABLE IF NOT EXISTS outreach_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    contact_id INTEGER,
    channel TEXT NOT NULL,                   -- email, linkedin, form
    template TEXT NOT NULL,                  -- template name
    subject TEXT,
    body TEXT,
    sent_at TIMESTAMP,
    opened_at TIMESTAMP,
    clicked_at TIMESTAMP,
    replied_at TIMESTAMP,
    reply_text TEXT,
    status TEXT DEFAULT 'sent',              -- sent, opened, clicked, replied, bounced, failed
    sequence_step INTEGER DEFAULT 1,
    FOREIGN KEY (lead_id) REFERENCES leads(id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    channel TEXT NOT NULL,
    subject_template TEXT,
    body_template TEXT,
    delay_days INTEGER DEFAULT 0,
    active BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_lead ON outreach_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach_log(status);
"""


@contextmanager
def get_conn(db_path: Path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db(db_path: Path):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with get_conn(db_path) as conn:
        conn.executescript(SCHEMA)
        
        # Insert default templates
        templates = [
            ("intro", "email", "Security gap in {company}'s {tech}", 
             "intro_email.j2", 0),
            ("value", "email", "3 findings for {company}",
             "value_email.j2", 2),
            ("social", "email", "{competitor} fixed this",
             "social_email.j2", 5),
            ("breakup", "email", "Closing the loop",
             "breakup_email.j2", 10),
        ]
        for name, channel, subject, body, delay in templates:
            conn.execute(
                "INSERT OR IGNORE INTO templates (name, channel, subject_template, body_template, delay_days) VALUES (?, ?, ?, ?, ?)",
                (name, channel, subject, body, delay)
            )
        conn.commit()


def upsert_lead(db_path: Path, lead: Dict[str, Any]) -> int:
    with get_conn(db_path) as conn:
        cursor = conn.execute(
            """INSERT INTO leads (source, company, website, domain, tech_stack, funding_info, 
                   hiring_signals, raw_data, score, pain_points, outreach_angle, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(company, source) DO UPDATE SET
                   website=excluded.website, domain=excluded.domain, tech_stack=excluded.tech_stack,
                   funding_info=excluded.funding_info, hiring_signals=excluded.hiring_signals,
                   raw_data=excluded.raw_data, score=excluded.score, pain_points=excluded.pain_points,
                   outreach_angle=excluded.outreach_angle, updated_at=CURRENT_TIMESTAMP
               RETURNING id""",
            (lead.get('source'), lead.get('company'), lead.get('website'),
             lead.get('domain'), json.dumps(lead.get('tech_stack', [])),
             json.dumps(lead.get('funding_info', {})), json.dumps(lead.get('hiring_signals', [])),
             json.dumps(lead.get('raw_data', {})), lead.get('score', 0),
             json.dumps(lead.get('pain_points', [])), lead.get('outreach_angle'),
             lead.get('status', 'new'))
        )
        return cursor.fetchone()[0]


def add_contact(db_path: Path, lead_id: int, contact: Dict[str, Any]) -> int:
    with get_conn(db_path) as conn:
        cursor = conn.execute(
            """INSERT INTO contacts (lead_id, email, name, role, source, verified, confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (lead_id, contact.get('email'), contact.get('name'),
             contact.get('role'), contact.get('source'),
             contact.get('verified', False), contact.get('confidence', 0))
        )
        return cursor.lastrowid


def log_outreach(db_path: Path, log: Dict[str, Any]) -> int:
    with get_conn(db_path) as conn:
        cursor = conn.execute(
            """INSERT INTO outreach_log (lead_id, contact_id, channel, template, subject, body,
                   sent_at, status, sequence_step)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (log.get('lead_id'), log.get('contact_id'), log.get('channel'),
             log.get('template'), log.get('subject'), log.get('body'),
             log.get('sent_at', datetime.now().isoformat()), log.get('status', 'sent'),
             log.get('sequence_step', 1))
        )
        return cursor.lastrowid


def update_outreach_status(db_path: Path, log_id: int, status: str, **kwargs):
    with get_conn(db_path) as conn:
        fields = ["status = ?"]
        values = [status]
        for k, v in kwargs.items():
            fields.append(f"{k} = ?")
            values.append(v)
        values.append(log_id)
        conn.execute(f"UPDATE outreach_log SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()


def get_leads_needing_outreach(db_path: Path, limit: int = 50) -> List[Dict]:
    with get_conn(db_path) as conn:
        # Leads that are enriched but not yet contacted, or need next sequence step
        rows = conn.execute(
            """SELECT l.*, c.email, c.name, c.role, c.id as contact_id
               FROM leads l
               LEFT JOIN contacts c ON c.lead_id = l.id AND c.verified = 1
               WHERE l.status IN ('enriched', 'site_generated', 'contacted')
               AND l.score >= 60
               ORDER BY l.score DESC, l.created_at ASC
               LIMIT ?""", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def get_leads_for_site_gen(db_path: Path) -> List[Dict]:
    with get_conn(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM leads WHERE status = 'enriched' AND score >= 60 ORDER BY score DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def update_lead_status(db_path: Path, lead_id: int, status: str):
    with get_conn(db_path) as conn:
        conn.execute("UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (status, lead_id))
        conn.commit()


def add_site(db_path: Path, lead_id: int, url: str, html_path: str):
    with get_conn(db_path) as conn:
        conn.execute(
            "INSERT INTO sites (lead_id, url, html_path, deployed_at) VALUES (?, ?, ?, ?)",
            (lead_id, url, html_path, datetime.now().isoformat())
        )
        conn.execute("UPDATE leads SET status = 'site_generated' WHERE id = ?", (lead_id,))
        conn.commit()


def get_new_replies(db_path: Path, since_hours: int = 24) -> List[Dict]:
    with get_conn(db_path) as conn:
        cutoff = datetime.now() - timedelta(hours=since_hours)
        rows = conn.execute(
            """SELECT ol.*, l.company, l.website
               FROM outreach_log ol
               JOIN leads l ON l.id = ol.lead_id
               WHERE ol.replied_at IS NOT NULL
               AND ol.replied_at > ?
               AND ol.status = 'replied'
               ORDER BY ol.replied_at DESC""", (cutoff.isoformat(),)
        ).fetchall()
        return [dict(r) for r in rows]


def get_stats(db_path: Path) -> Dict:
    with get_conn(db_path) as conn:
        stats = {}
        stats['total_leads'] = conn.execute("SELECT COUNT(*) FROM leads").fetchone()[0]
        stats['by_status'] = dict(conn.execute("SELECT status, COUNT(*) FROM leads GROUP BY status").fetchall())
        stats['total_contacts'] = conn.execute("SELECT COUNT(*) FROM contacts WHERE verified = 1").fetchone()[0]
        stats['emails_sent'] = conn.execute("SELECT COUNT(*) FROM outreach_log WHERE channel = 'email' AND status != 'failed'").fetchone()[0]
        stats['replies'] = conn.execute("SELECT COUNT(*) FROM outreach_log WHERE replied_at IS NOT NULL").fetchone()[0]
        stats['sites'] = conn.execute("SELECT COUNT(*) FROM sites").fetchone()[0]
        return stats