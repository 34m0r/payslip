import "./polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Employee } from "./Employee";
import { Verifier } from "./Verifier";
import "./styles.css";

const path = location.pathname.replace(/\/+$/, "");
// Requests and attestations travel in the URL fragment, read once at load: a new one in the
// same tab (a pasted link) changes only the fragment, so reload to read it.
addEventListener("hashchange", () => location.reload());

const Page = path === "/salarie" ? Employee : path === "/verifier" ? Verifier : App;

createRoot(document.getElementById("root")!).render(<StrictMode><Page /></StrictMode>);
