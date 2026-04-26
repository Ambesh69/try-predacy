/**
 * Shared RPC + gRPC endpoint constants.
 *
 * All scripts and runtime modules import from here so we have ONE place
 * to rotate keys / endpoints. Predacy is on RPC Fast's max plan — every
 * connection across the codebase uses these endpoints by default.
 *
 * If you ever need to override per-environment (e.g. testing on a
 * different RPC node), set the corresponding env var. Otherwise the
 * constants below are used directly.
 */

/** RPC Fast HTTP devnet RPC. Used as the primary Solana connection for
 *  the relayer + every script in /scripts. */
export const RPC_FAST_API_KEY =
  process.env.RPC_FAST_API_KEY ||
  "Mera4YdtfZgVWW3Nzkizi0LzY6wQb8PJrnUrjSvlNi3zbpdxm8tO7E6PAYSrggUH";

export const RPC_FAST_URL = `https://sol-devnet-rpc.rpcfast.com/?api_key=${RPC_FAST_API_KEY}`;

/** RPC Fast WSS endpoint for subscription-based listeners. */
export const RPC_FAST_WSS_URL = `wss://sol-devnet-rpc.rpcfast.com/?api_key=${RPC_FAST_API_KEY}`;

/** RPC Fast Yellowstone gRPC endpoint for log streaming. Separate API key
 *  from the HTTP RPC. */
export const RPC_FAST_GRPC_API_KEY =
  process.env.RPC_FAST_GRPC_API_KEY ||
  "mBqYq9rHfLLl10VKCUdLfKOvZX0NOPDqXseKinMS5l4cnRIVErzBj5EtmOrVoCJD";

/** RPC Fast Yellowstone gRPC endpoint. NB: `@triton-one/yellowstone-grpc`'s
 *  napi-rs client rejects `https://` prefix with "invalid TLS configuration".
 *  Bare `host:port` is what the Rust binding expects — TLS is implied by
 *  port 443 + the channel options.  `.trim()` handles trailing-newline
 *  pastes in env vars (which produce the same TLS error). */
export const RPC_FAST_YELLOWSTONE_URL = (
  process.env.RPC_FAST_YELLOWSTONE_URL ||
  "sol-devnet-yellowstone-grpc.rpcfast.com:443"
).trim();

/** Encrypt's pre-alpha coprocessor gRPC endpoint (CreateInput / ReadCiphertext). */
export const ENCRYPT_GRPC_URL = "pre-alpha-dev-1.encrypt.ika-network.net:443";
