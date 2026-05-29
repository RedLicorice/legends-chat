// DM message content codec. Plan A stores plaintext (server-readable). The
// codec exists as the single isolation point so Plan B can swap in an E2EE
// envelope without touching the insert/read paths.
export function encodeDmContent(text: string): string {
  return text;
}

export function decodeDmContent(raw: string): string {
  return raw;
}
