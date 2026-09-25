import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [arm, amountStr, currency, ...noteParts] = process.argv.slice(2);

if (!arm || !amountStr || !currency) {
  console.error("usage: node agent/record.mjs <arm> <amount> <currency> <note...>");
  process.exit(1);
}
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
ledger.push(entry);
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");

// allocation: only ever from earned money
const a = config.allocation;
state.totalRevenue = (state.totalRevenue || 0) + (entry.currency === "USDT" || entry.currency === "USD" ? amount : 0);
state.lastRevenueAt = entry.ts;
if (state.status !== "dead") state.status = "alive"; // revenue revives the agent
state.budgets = state.budgets || { reinvest: 0, reserve: 0, ownerPayout: 0 };
state.budgets.reinvest = +(state.budgets.reinvest + amount * a.reinvest).toFixed(4);
state.budgets.reserve = +(state.budgets.reserve + amount * a.reserve).toFixed(4);
state.budgets.ownerPayout = +(state.budgets.ownerPayout + amount * a.ownerPayout).toFixed(4);

writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

console.log("recorded:", entry);
console.log("budgets:", state.budgets);
console.log("agent status revived ->", state.status);
