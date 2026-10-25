// POST /api/payroll: runs one real testnet payroll and streams its progress as NDJSON lines
// ({type:"phase"|"update"|"done"|"error"}), which the globe animates as they arrive.
// bb.js caches its CRS under $HOME: on Vercel only /tmp is writable.
if (process.env.VERCEL) process.env.HOME = "/tmp";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { runPayroll } = await import("../server/testnet.js");
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const emit = (line) => res.write(JSON.stringify(line) + "\n");
  try {
    await runPayroll(emit);
  } catch (e) {
    emit({ type: "error", status: e.status ?? 500, message: e.message });
  }
  res.end();
}
