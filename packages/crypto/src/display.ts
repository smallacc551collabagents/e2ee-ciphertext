// Decrypt/render boundary (E2EE-44). Decrypted plaintext is attacker-controlled input:
// render it as text only (never HTML), and neutralise characters that can spoof the UI.

/** Max characters rendered for one message; longer text is truncated with an ellipsis. */
export const DISPLAY_MAX_CHARS = 4000;

// C0/C1 controls except \t and \n, plus DEL.
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Bidi embeddings/overrides/isolates (Trojan-Source style spoofing) and stray BOM.
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\uFEFF]/g;

/**
 * Make decrypted plaintext safe to render as a React text node: drops control and
 * bidi-override characters, normalises CRLF, caps length. Never returns markup.
 */
export function toDisplayText(plaintext: string): string {
  let s = plaintext.replace(/\r\n?/g, '\n').replace(CONTROLS, '').replace(BIDI, '').normalize('NFC');
  if (s.length > DISPLAY_MAX_CHARS) s = `${s.slice(0, DISPLAY_MAX_CHARS)}…`;
  return s;
}
