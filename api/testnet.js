// GET /api/testnet: which testnet actions this deployment can run (the UI offers only those).
import { capabilities } from "../server/testnet.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(capabilities());
}
