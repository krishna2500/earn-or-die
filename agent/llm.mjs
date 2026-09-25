const MODEL = process.env.THINK_MODEL || "@cf/meta/llama-3.1-8b-instruct";

export async function chat(system, user, opts = {}) {
  const token = process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!token || !accountId) throw new Error("CF_API_TOKEN/CF_ACCOUNT_ID missing");
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens ?? 2000,
    }),
    signal: AbortSignal.timeout(opts.timeout_ms ?? 90000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.success) throw new Error(`workers-ai ${r.status}: ${JSON.stringify(j?.errors || []).slice(0, 200)}`);
  const raw = j.result?.choices?.[0]?.message?.content || "";
  return raw;
}

export function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

export function extractFence(text, path) {
  // prefer fenced block whose info string mentions the path
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  const blocks = [];
  while ((m = re.exec(text))) blocks.push({ info: (m[0].split("\n")[0] || "").toLowerCase(), body: m[1] });
  if (!blocks.length) return null;
  const byPath = blocks.find((b) => path && b.info.includes(path.toLowerCase().split("/").pop()));
  return (byPath || blocks[blocks.length - 1]).body;
}
