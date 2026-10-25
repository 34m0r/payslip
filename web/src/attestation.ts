/** Short attestation links, QR codes and real ledger dates, shared by the employee and verifier pages. */
import QRCode from "qrcode";
import type { IncomeBundle } from "./income/dincome";

/** Store the bundle server-side and return its short verifier link (null if the store is unavailable). */
export async function shareAttestation(bundle: IncomeBundle): Promise<string | null> {
  try {
    const res = await fetch("/api/attestation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle) });
    if (!res.ok) return null;
    const { id } = (await res.json()) as { id: string };
    return `${location.origin}/verifier#a=${id}`;
  } catch {
    return null;
  }
}

export async function fetchAttestation(id: string): Promise<IncomeBundle> {
  const res = await fetch(`/api/attestation?id=${encodeURIComponent(id)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error === "attestation not found" ? "attestation introuvable" : (json.error ?? `erreur ${res.status}`));
  return json as IncomeBundle;
}

export const qrDataUrl = (text: string) =>
  QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: 360, color: { dark: "#18233F", light: "#FFFFFF" } });

// Ledger close times from Horizon, so salaries show as dates rather than ledger numbers.
const times = new Map<number, Promise<Date | null>>();
export function ledgerTime(seq: number): Promise<Date | null> {
  if (!times.has(seq)) {
    times.set(seq, fetch(`https://horizon-testnet.stellar.org/ledgers/${seq}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((l: { closed_at?: string } | null) => (l?.closed_at ? new Date(l.closed_at) : null))
      .catch(() => null));
  }
  return times.get(seq)!;
}
export const formatDate = (d: Date) => d.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
