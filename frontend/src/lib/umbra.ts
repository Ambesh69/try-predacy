/**
 * Umbra Privacy integration for Predacy.
 *
 * Privacy flow:
 * 1. User generates an ephemeral keypair (saved in localStorage for later claim).
 * 2. User signs an Umbra UTXO transfer: USDC from main wallet → claimable UTXO
 *    addressed to the ephemeral keypair.
 * 3. Ephemeral keypair claims the UTXO into its own public balance.
 * 4. Ephemeral keypair signs the Predacy commit_order — only the ephemeral
 *    pubkey appears on-chain, breaking the link to the user's main wallet.
 * 5. At claim time, the ephemeral keypair signs claim_with_proof and the
 *    received tokens (or USDC) can be sent back through the Umbra mixer to
 *    the user's main wallet for full round-trip privacy.
 *
 * Combined with our existing ZK commitments (which hide amount, side, price),
 * this gives a triple-layered privacy stack:
 *   - Wallet identity hidden via Umbra mixer
 *   - Order details hidden via Poseidon commitment + Groth16 ZK proof
 *   - Settlement attestation only on-chain, never plaintext orders
 */

const STORAGE_KEY_PREFIX = "predacy:umbra:ephemeral:";

export interface EphemeralWallet {
  publicKey: string;        // Solana base58 address
  secretKey: string;        // base58-encoded full secret key (64 bytes)
  createdAt: number;        // unix ms
  marketId: string;         // which market this was for
  funded: boolean;          // whether the Umbra mixer transfer completed
  utxoCommitment?: string;  // Umbra UTXO commitment hash for tracking
}

/**
 * Generate a fresh ephemeral keypair for a private order.
 * This keypair is the on-chain identity that will appear in the commit_order
 * transaction — completely unlinked from the user's main wallet.
 */
export async function generateEphemeralWallet(marketId: string): Promise<EphemeralWallet> {
  const { Keypair } = await import("@solana/web3.js");
  const bs58 = await import("bs58");
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey.toBase58(),
    secretKey: bs58.default.encode(kp.secretKey),
    createdAt: Date.now(),
    marketId,
    funded: false,
  };
}

/** Persist an ephemeral wallet so the user can later claim positions from it. */
export function saveEphemeralWallet(userWallet: string, ephemeral: EphemeralWallet): void {
  const key = STORAGE_KEY_PREFIX + userWallet;
  const list: EphemeralWallet[] = JSON.parse(localStorage.getItem(key) || "[]");
  list.push(ephemeral);
  // Cap at 100 to prevent unbounded growth
  if (list.length > 100) list.shift();
  localStorage.setItem(key, JSON.stringify(list));
}

export function getEphemeralWallets(userWallet: string): EphemeralWallet[] {
  const key = STORAGE_KEY_PREFIX + userWallet;
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

export function markEphemeralFunded(userWallet: string, ephemeralPubkey: string, utxoCommitment?: string): void {
  const key = STORAGE_KEY_PREFIX + userWallet;
  const list: EphemeralWallet[] = JSON.parse(localStorage.getItem(key) || "[]");
  const updated = list.map((e) =>
    e.publicKey === ephemeralPubkey ? { ...e, funded: true, utxoCommitment } : e
  );
  localStorage.setItem(key, JSON.stringify(updated));
}

/**
 * Initialize the Umbra client lazily. The SDK is heavy (~16MB) so we only
 * load it when the user actually opts into private mode.
 *
 * Returns null on devnet/localnet if the Umbra contracts aren't deployed —
 * caller should fall back to direct deposit in that case and surface a
 * "Privacy unavailable on this network" notice.
 */
export async function getUmbraClient(walletStandard: any) {
  try {
    const sdk: any = await import("@umbra-privacy/sdk");
    const network = (process.env.NEXT_PUBLIC_UMBRA_NETWORK as any) || "devnet";
    const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
    // Privy doesn't expose Solana wallet-standard interface directly.
    // For the hackathon devnet demo we degrade gracefully — the ephemeral
    // keypair pattern alone provides the wallet-unlinkability story; routing
    // via the Umbra mixer is an additional production-deployment step.
    if (!walletStandard?.wallet || !walletStandard?.account) {
      return null;
    }
    const signer = sdk.createSignerFromWalletAccount(walletStandard.wallet, walletStandard.account);
    const client = await sdk.getUmbraClient({
      signer,
      network,
      rpcUrl,
      rpcSubscriptionsUrl: rpcUrl.replace("https://", "wss://").replace("http://", "ws://"),
      indexerApiEndpoint: process.env.NEXT_PUBLIC_UMBRA_INDEXER || "https://indexer.umbraprivacy.com",
    });
    return { client, sdk };
  } catch (err) {
    console.warn("[Predacy] Umbra client unavailable:", err);
    return null;
  }
}

/**
 * Send USDC from the user's main wallet through the Umbra mixer to the
 * ephemeral keypair. After this completes, the ephemeral keypair has USDC
 * with no on-chain link back to the user.
 */
export async function fundEphemeralViaUmbra(
  walletStandard: any,
  ephemeral: EphemeralWallet,
  usdcMint: string,
  amountMicro: bigint,
): Promise<{ ok: boolean; error?: string; commitment?: string }> {
  const initialized = await getUmbraClient(walletStandard);
  if (!initialized) {
    return { ok: false, error: "Umbra unavailable — falling back to direct deposit" };
  }
  const { client, sdk } = initialized as any;

  try {
    const register = sdk.getUserRegistrationFunction({ client });
    await register({ confidential: true, anonymous: true });

    const createUtxo = sdk.getPublicBalanceToReceiverClaimableUtxoCreatorFunction({ client });
    const result = await createUtxo({
      receiverAddress: ephemeral.publicKey,
      mint: usdcMint,
      amount: amountMicro,
    });

    return { ok: true, commitment: result?.utxoCommitment };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Umbra transfer failed" };
  }
}
