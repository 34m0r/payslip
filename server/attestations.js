// Short links for income attestations. An attestation carries a 16 KB proof, far too long for a QR
// code, so the server keeps the bundle and hands out a short id. The store is transport only: the
// verifier still rebuilds every public input from chain state, so a tampered bundle fails anyway.
// Vercel Blob (private) when BLOB_READ_WRITE_TOKEN is set; a local folder otherwise (dev).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get, put } from "@vercel/blob";

const LOCAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "../.attestations");
const ID = /^[A-Za-z0-9_-]{12}$/;
const MAX_BYTES = 64 * 1024;
const useBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;

export class AttestationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Store a bundle (shape-checked, not trusted) and return its short id. */
export async function saveAttestation(bundle) {
  const ok = bundle && bundle.circuitId === "disclose_income" && Array.isArray(bundle.refs) && bundle.refs.length === 3
    && typeof bundle.proof === "string" && typeof bundle.holder === "string" && bundle.request && typeof bundle.request === "object";
  if (!ok) throw new AttestationError(400, "not an income attestation");
  const body = JSON.stringify(bundle);
  if (body.length > MAX_BYTES) throw new AttestationError(413, "attestation too large");
  const id = randomBytes(9).toString("base64url");
  if (useBlob()) {
    await put(`attestations/${id}.json`, body, { access: "private", contentType: "application/json", addRandomSuffix: false });
  } else {
    mkdirSync(LOCAL_DIR, { recursive: true });
    writeFileSync(join(LOCAL_DIR, `${id}.json`), body);
  }
  return id;
}

export async function loadAttestation(id) {
  if (!ID.test(String(id ?? ""))) throw new AttestationError(400, "invalid id");
  if (useBlob()) {
    const r = await get(`attestations/${id}.json`, { access: "private" });
    if (!r) throw new AttestationError(404, "attestation not found");
    return JSON.parse(await new Response(r.stream).text());
  }
  const file = join(LOCAL_DIR, `${id}.json`);
  if (!existsSync(file)) throw new AttestationError(404, "attestation not found");
  return JSON.parse(readFileSync(file, "utf8"));
}
