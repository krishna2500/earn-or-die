export async function run() {
  const hasKey = !!process.env.CRYPTOBOT_API_KEY;
  return {
    ok: true,
    status: hasKey ? "ready" : "awaiting-cryptobot-key",
    notes: [
      "Micro-product funnel: free infra (CF Workers/Pages) + crypto checkout -> USDT TRC-20 payout wallet.",
      "Blocked on: CryptoBot API key (owner: @CryptoBot on Telegram -> /api -> Create API Key).",
      "Second blocker (same for all arms): distribution — owner must paste product link somewhere, once.",
    ],
  };
}
