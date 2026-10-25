// The confidential token SDK encodes contract payloads with Node's Buffer (chain/payload.ts).
import { Buffer } from "buffer";

(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
