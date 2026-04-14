export function getRelayerUrl(): string {
  return process.env.NEXT_PUBLIC_RELAYER_URL || "http://localhost:3001";
}
