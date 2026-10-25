import { useEffect, useRef, useState } from "react";

const GLYPHS = "0123456789abcdef";
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Shows the ciphertext in public view, and "decrypts" to the plaintext in auditor view:
 * characters scramble for a moment, then settle left to right. Answers the user's toggle.
 */
export function Decrypt({ revealed, cipher, plain, delay = 0 }: { revealed: boolean; cipher: string; plain: string; delay?: number }) {
  const target = revealed ? plain : cipher;
  const [text, setText] = useState(target);
  const first = useRef(true);

  useEffect(() => {
    if (first.current || reduced()) { first.current = false; setText(target); return; }
    // Time-based (not frame-based): same duration on a fast laptop or a slow machine.
    const DURATION = 420;
    let raf = 0, start = 0;
    const tick = (t: number) => {
      if (!start) start = t;
      const p = (t - start - delay) / DURATION;
      if (p < 0) { raf = requestAnimationFrame(tick); return; }
      if (p >= 1) { setText(target); return; }
      const settled = Math.floor(p * target.length);
      setText(Array.from(target, (ch, i) => (i < settled || ch === " " ? ch : GLYPHS[(Math.random() * 16) | 0])).join(""));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, delay]);

  return <span className={revealed ? "amount" : "amount amount--cipher"} aria-label={revealed ? plain : "Montant chiffré"}>{text}</span>;
}
