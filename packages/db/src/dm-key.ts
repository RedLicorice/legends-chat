export type DmPrincipal = { type: "user" | "bot"; id: string };

function token(p: DmPrincipal): string {
  return `${p.type === "bot" ? "b" : "u"}:${p.id}`;
}

/**
 * Deterministic, order-independent key identifying a 1:1 conversation between
 * two principals. Used as a UNIQUE constraint so opening a DM is idempotent.
 */
export function buildDmKey(a: DmPrincipal, b: DmPrincipal): string {
  const ta = token(a);
  const tb = token(b);
  if (ta === tb) throw new Error("cannot open a DM with self");
  return ta < tb ? `${ta}|${tb}` : `${tb}|${ta}`;
}
