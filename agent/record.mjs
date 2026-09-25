import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function applyEntry(config, state, ledger, entry) {
  ledger.push(entry);
  const a = config.allocation;
  const isMoney = entry.currency === "USDT" || entry.currency === "USD";
  if (isMoney) {
    state.totalRevenue = (state.totalRevenue || 0) + entry.amount;
    state.lastRevenueAt = entry.ts;
    if (state.status !== "dead") state.status = "alive";
    state.budgets = state.budgets || { reinvest: 0, reserve: 0, ownerPayout: 0 };
    state.budgets.reinvest = +(state.budgets.reinvest + entry.amount * a.reinvest).toFixed(4);
    state.budgets.reserve = +(state.budgets.reserve + entry.amount * a.reserve).toFixed(4);
    state.budgets.ownerPayout = +(state.budgets.ownerPayout + entry.amount * a.ownerPayout).toFixed(4);
  } else {
    // non-USD bounty (EUR etc.): track in ledger only — budgets are USDT-denominated
    state.lastRevenueAt = entry.ts;
    if (state.status !== "dead") state.status = "alive";
  }
  return entry;
}

export function record(arm, amountStr, currency, ...noteParts) {
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error("amount must be a positive number");
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(`${HERE}/../config.json`, "utf8"));
  const statePath = `${HERE}/state/state.json`;
  const ledgerPath = `${HERE}/state/ledger.json`;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : [];

  const entry = {
    ts: new Date().toISOString(),
    arm,
    amount,
    currency: currency.toUpperCase(),
    note: noteParts.join(" ") || "",
  };
  applyEntry(config, state, ledger, entry);
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

  console.log("recorded:", entry);
  console.log("budgets:", state.budgets);
  console.log("agent status revived ->", state.status);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [arm, amountStr, currency, ...noteParts] = process.argv.slice(2);
  if (!arm || !amountStr || !currency) {
    console.error("usage: node agent/record.mjs <arm> <amount> <currency> <note...>");
    process.exit(1);
  }
  record(arm, amountStr, currency, ...noteParts);
}
