import { useEffect, useState } from "react";
import { formatDate, ledgerTime } from "./attestation";

/** The close time of a ledger ("25 oct. 2026, 18:42"), falling back to its number. */
export function LedgerDate({ ledger }: { ledger: number }) {
  const [date, setDate] = useState<Date | null>(null);
  useEffect(() => { ledgerTime(ledger).then(setDate); }, [ledger]);
  return <span title={`Ledger ${ledger}`}>{date ? formatDate(date) : `Ledger ${ledger}`}</span>;
}
