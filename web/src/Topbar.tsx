import type { ReactNode } from "react";
import { COMPANY } from "./data";

export type Route = "employer" | "employee" | "verifier";
const LINKS: { id: Route; href: string; label: string }[] = [
  { id: "employer", href: "/", label: "Employer" },
  { id: "employee", href: "/employee", label: "Employee" },
  { id: "verifier", href: "/verifier", label: "Verify" },
];

export function Topbar({ current, children }: { current: Route; children?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark" aria-hidden="true" />
        <span className="brand__name">Payslip</span>
        <span className="brand__company">{COMPANY.name}</span>
      </div>
      <nav className="nav" aria-label="Sections">
        {LINKS.map((l) => <a key={l.id} href={l.href} aria-current={l.id === current ? "page" : undefined}>{l.label}</a>)}
      </nav>
      {children}
    </header>
  );
}
