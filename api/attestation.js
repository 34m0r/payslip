// POST /api/attestation (bundle) → {id};  GET /api/attestation?id=… → bundle.
import { loadAttestation, saveAttestation } from "../server/attestations.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") return res.status(200).json({ id: await saveAttestation(req.body) });
    if (req.method === "GET") return res.status(200).json(await loadAttestation(req.query.id));
    res.status(405).json({ error: "GET or POST" });
  } catch (e) {
    res.status(e.status ?? 500).json({ error: e.message });
  }
}
