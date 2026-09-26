import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = `${HERE}/../out`;

export async function run(config, state) {
  console.log("[scan] Starting Nuclei + LLM triage via Python bridge");
  
  const bountiesFile = `${OUT}/bounties.json`;
  if (!existsSync(bountiesFile)) {
    return { ok: true, total: 0, actionable: 0, changed: false, note: "No bounties data" };
  }
  
  const bounties = JSON.parse(readFileSync(bountiesFile, "utf8"));
  const fresh = bounties.fresh || [];
  if (!fresh.length) {
    return { ok: true, total: 0, actionable: 0, changed: false, note: "No fresh bounties" };
  }
  
  // Extract targets
  const targets = [];
  const targetContext = {};
  for (const bounty of fresh.slice(0, 10)) {
    const repo = bounty.repo;
    if (repo) {
      targets.push(`https://github.com/${repo}`);
      targetContext[repo] = {
        company: repo.split("/")[0],
        program: bounty.source,
        scope: bounty.url
      };
    }
  }
  
  if (!targets.length) {
    return { ok: true, total: 0, actionable: 0, changed: false };
  }
  
  console.log(`[scan] Scanning ${targets.length} targets with Nuclei`);
  
  // Run Python scanner
  const scannerPath = `${HERE}/scan.py`;
  const input = JSON.stringify({ targets, targetContext });
  
  const result = await runPythonScanner(scannerPath, input);
  
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  
  console.log(`[scan] Nuclei found ${result.total} findings, ${result.actionable} actionable`);
  
  // Save findings for act.mjs to use
  if (result.findings && result.findings.length) {
    writeFileSync(`${OUT}/scan_findings.json`, JSON.stringify(result.findings, null, 2));
    writeFileSync(`${OUT}/scan_report.md`, result.report || "");
  }
  
  return {
    ok: true,
    total: result.total,
    actionable: result.actionable,
    changed: result.actionable > 0,
    candidates: result.findings || []
  };
}

function runPythonScanner(scriptPath, input) {
  return new Promise((resolve) => {
    const py = spawn("python3", [scriptPath], { 
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 600000 // 10 min
    });
    
    let stdout = "";
    let stderr = "";
    
    py.stdin.write(input);
    py.stdin.end();
    
    py.stdout.on("data", (data) => stdout += data.toString());
    py.stderr.on("data", (data) => stderr += data.toString());
    
    py.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr || `Exit code ${code}` });
        return;
      }
      try {
        const lastLine = stdout.trim().split('\n').pop();
        resolve(JSON.parse(lastLine));
      } catch (e) {
        resolve({ ok: false, error: `Parse error: ${e.message}`, stdout });
      }
    });
    
    py.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}