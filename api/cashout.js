// POST /api/cashout {action: "start"|"status"|"settle", employeeId, amount?, id?}: an employee's
// cash-out through Payslip's anchor, signed server-side (no key in the browser).
// bb.js caches its CRS under $HOME: on Vercel only /tmp is writable.
if (process.env.VERCEL) process.env.HOME = "/tmp";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { cashoutStart, cashoutStatus, cashoutSettle } = await import("../server/testnet.js");
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const origin = `https://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
  const action = { start: cashoutStart, status: cashoutStatus, settle: cashoutSettle }[body.action];
  if (!action) return res.status(400).json({ error: "unknown action" });
  try {
    res.status(200).json(await action(origin, body));
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
}
