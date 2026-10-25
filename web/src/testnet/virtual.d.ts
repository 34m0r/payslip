declare module "virtual:payslip-testnet" {
  export interface TestnetEmployee { id: string; name: string; city: string; salary: number; address: string }
  export interface TestnetPayroll {
    period: string;
    at: string;
    total: number;
    deposit: string;
    merge: string;
    transfers: { employeeId: string; to: string; tx: string; ledger: number; eventId: string; vTilde: string }[];
  }
  export interface TestnetDeployment {
    network: "testnet";
    fromLedger: number;
    employer: { name: string; address: string };
    employees: TestnetEmployee[];
    contracts: { verifier: string; auditor: string; factory: string; policy: string; token: string; underlying: string };
    payrolls?: TestnetPayroll[];
  }
  export const deployment: TestnetDeployment | null;
  /** Demo employees' confidential READ keys `sk` (hex), by employee id: decrypt and prove, move
   *  no funds. Dev builds, and production builds with PAYSLIP_DEMO_KEYS=1. */
  export const demoKeys: Record<string, string>;
}
