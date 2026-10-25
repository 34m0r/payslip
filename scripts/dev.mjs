/** Starts the Payslip web app and opens it in Brave (override with BROWSER=...). */
import { spawn } from "node:child_process";
const brave = { darwin: "Brave Browser", win32: "brave", linux: "brave-browser" }[process.platform] ?? "brave";
const env = { ...process.env, BROWSER: process.env.BROWSER ?? brave };
console.log(`Opening http://localhost:5174 in: ${env.BROWSER}`);
const child = spawn("npx", ["vite"], { stdio: "inherit", env, shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
