export function buildChallengeMessage(address: string, nonce: string, issuedAt: string): string {
  return `Sign in to Legends Chat\n\nAddress: ${address}\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
}
