// Vercel function serving Payslip's testnet anchor on the app's own domain:
// /.well-known/stellar.toml, /auth and /sep24/* are rewritten here (vercel.json).
// Needs ANCHOR_SIGNING_SECRET, ANCHOR_DISTRIBUTION_SECRET and ANCHOR_JWT_SECRET in the environment.
import { CORS, handle } from "../server/anchor-core.js";

export default async function handler(req, res) {
  const { __path = "", ...query } = req.query;
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const out = await handle({
    method: req.method,
    path: `/${__path}`,
    query,
    headers: req.headers,
    body: req.body && typeof req.body === "object" ? req.body : {},
    origin: `https://${host}`,
  }).catch((e) => ({ status: 500, type: "application/json", body: JSON.stringify({ error: e.message }) }));
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.setHeader("Content-Type", out.type);
  res.status(out.status).send(out.body);
}
