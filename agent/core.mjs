import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
const write = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
};

const config = JSON.parse(readFileSync(`${HERE}/../config.json`, "utf8"));
let state = read(`${HERE}/state/state.json`, null);
if (!state) {
  state = {
    born: new Date().toISOString().slice(0, 10),
    status: "alive",
    cycle: 0,
    lastRevenueAt: null,
    totalRevenue: 0,
    budgets: { reinvest: 0, reserve: 0, ownerPayout: 0 },
    armStatus: {},
  };
}
const ledger = read(`${HERE}/state/ledger.json`, []);

const DAY = 86400000;
const daysAlive = Math.floor((Date.now() - +new Date(state.born)) / DAY);
const daysSinceRev = state.lastRevenueAt
  ? Math.floor((Date.now() - +new Date(state.lastRevenueAt)) / DAY)
  : daysAlive;

// ---- EARN OR DIE ----
if (state.status !== "dead") {
  if (daysSinceRev >= config.killRule.deadAfterDays) state.status = "dead";
  else if (daysSinceRev >= config.killRule.dyingAfterDays) state.status = "dying";
}

const summary = { daysAlive, daysSinceRev, status: state.status, found: 0, recorded: 0, arms: {} };
state.daysAlive = daysAlive;
state.daysSinceRev = daysSinceRev;
const FAST = !!process.env.FAST_ARM;
const list = config.arms.filter((a) => a.enabled && (!FAST || a.id === process.env.FAST_ARM));
let changed = false;

if (state.status !== "dead") {
  for (const arm of list) {
    try {
      const mod = await import(`${HERE}/arms/${arm.id}.mjs`);
      const result = await mod.run(config, state);
      const { events, ...stored } = result;
      state.armStatus[arm.id] = { at: new Date().toISOString(), ...stored };
      summary.arms[arm.id] = stored;
      if (arm.id === "bounties" && result?.candidates) summary.found = result.candidates.length;
      if (result?.changed) changed = true;
      if (Array.isArray(events) && events.length) {
        const { applyEntry } = await import(`${HERE}/record.mjs`);
        for (const ev of events) {
          const amt = Number(ev.amount);
          if (!Number.isFinite(amt) || amt <= 0) continue;
          const note = (ev.note || "").trim();
          if (note && ledger.some((e) => e.note === note)) continue;
          applyEntry(config, state, ledger, {
            ts: ev.ts || new Date().toISOString(),
            arm: arm.id,
            amount: amt,
            currency: ev.currency || "USDT",
            note,
          });
          summary.recorded += 1;
        }
        write(`${HERE}/state/ledger.json`, ledger);
      }
    } catch (e) {
      const err = { ok: false, error: String(e?.message || e).slice(0, 300) };
      state.armStatus[arm.id] = { at: new Date().toISOString(), ...err };
      summary.arms[arm.id] = err;
    }
  }
} else {
  summary.arms.skipped = "agent is DEAD — arms not run";
}

// fleet: clone a new niche storefront only after real revenue (config.fleet.cloneAfterUSD)
if (!FAST && state.status !== "dead" && (state.totalRevenue || 0) >= (config.fleet?.cloneAfterUSD ?? Infinity)) {
  try {
    const fleet = await import(`${HERE}/clone.mjs`);
    summary.fleet = await fleet.run(config, state);
  } catch (e) {
    summary.fleet = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

// quiet fast-scout run: nothing new → touch nothing (no state write, no commit, no TG)
if (FAST && state.status !== "dead" && summary.found === 0 && !changed) {
  console.log(JSON.stringify({ fast: process.env.FAST_ARM, cycle: state.cycle, status: state.status, found: 0, quiet: true }));
  process.exit(0);
}

if (!FAST) state.cycle += 1;
write(`${HERE}/state/state.json`, state);

// ---- report: every full cycle; fast-scout only when actionable bounty found ----
if (!FAST || summary.found > 0) {
  try {
    const { report } = await import(`${HERE}/arms/report.mjs`);
    await report(state, summary, config, ledger);
  } catch (e) {
    console.log("report skipped:", String(e?.message || e));
  }
}

console.log(JSON.stringify({ cycle: state.cycle, ...summary }, null, 2));

if (state.status === "dead") process.exit(2); // workflow: self-destruct cron
