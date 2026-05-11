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

// Default Umbra SDK options shared between the two client-initialization
// paths. Kept here so swapping RPC/indexer config is a one-liner.
async function umbraClientOptions() {
  const network = (process.env.NEXT_PUBLIC_UMBRA_NETWORK as any) || "devnet";
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const rpcSubscriptionsUrl = rpcUrl.replace("https://", "wss://").replace("http://", "ws://");
  // Umbra devnet endpoints (per https://sdk.umbraprivacy.com/llms.txt).
  // Mainnet defaults (indexer.umbraprivacy.com) don't serve devnet data —
  // this is the fix that unblocked real shield flows on Solana devnet.
  //   devnet program ID: DSuKkyqGVGgo4QtPABfxKJKygUDACbUhirnuv63mEpAJ
  const defaultIndexer =
    network === "devnet"
      ? "https://utxo-indexer.api-devnet.umbraprivacy.com"
      : "https://indexer.umbraprivacy.com";
  const indexerApiEndpoint = process.env.NEXT_PUBLIC_UMBRA_INDEXER || defaultIndexer;
  return { network, rpcUrl, rpcSubscriptionsUrl, indexerApiEndpoint };
}

/**
 * Phase B: build an Umbra client directly from an ephemeral Keypair.
 *
 * The SDK exposes `createSignerFromPrivateKeyBytes` which accepts raw
 * 32-byte Ed25519 private key bytes. An ephemeral `Keypair` stores its
 * secret as 64 bytes (32 priv || 32 pub) — the first 32 are what the
 * signer wants. This lets the ephemeral authorize Umbra operations
 * (shield, internal transfer, unshield) on its OWN balance, without
 * needing a wallet-standard adapter.
 *
 * Returns null if the SDK fails to initialize (devnet without Umbra
 * contracts, indexer unreachable, etc.) — callers must graceful-degrade.
 */
export async function getUmbraClientFromEphemeral(ephemeral: EphemeralWallet) {
  try {
    const sdk: any = await import("@umbra-privacy/sdk");
    const bs58mod = await import("bs58");
    const bs58 = (bs58mod as any).default ?? bs58mod;
    const { network, rpcUrl, rpcSubscriptionsUrl, indexerApiEndpoint } = await umbraClientOptions();

    // Decode the stored base58 secret → 64 bytes; Ed25519 private key is the first 32.
    const secret = bs58.decode(ephemeral.secretKey) as Uint8Array;
    const privKeyBytes = secret.slice(0, 32);

    const signer = await sdk.createSignerFromPrivateKeyBytes(privKeyBytes);
    const client = await sdk.getUmbraClient({
      signer,
      network,
      rpcUrl,
      rpcSubscriptionsUrl,
      indexerApiEndpoint,
    });
    return { client, sdk };
  } catch (err) {
    console.warn("[Predacy] Umbra client (ephemeral signer) unavailable:", err);
    return null;
  }
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
    // Privy doesn't expose Solana wallet-standard interface directly.
    // On devnet we degrade gracefully — the ephemeral keypair pattern
    // alone provides the wallet-unlinkability story; routing via the
    // Umbra mixer is an additional production-deployment step.
    if (!walletStandard?.wallet || !walletStandard?.account) {
      return null;
    }
    const { network, rpcUrl, rpcSubscriptionsUrl, indexerApiEndpoint } = await umbraClientOptions();
    // Privacy-sensitive: RPC provider sees every lookup. Configure a no-log
    // privacy RPC in NEXT_PUBLIC_SOLANA_RPC_URL for mainnet — see
    // frontend/.env.example for recommended providers (Helius, Triton, Ankr).
    const signer = sdk.createSignerFromWalletAccount(walletStandard.wallet, walletStandard.account);
    const client = await sdk.getUmbraClient({
      signer,
      network,
      rpcUrl,
      rpcSubscriptionsUrl,
      indexerApiEndpoint,
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

/**
 * Phase B: shield the ephemeral's public balance into the Umbra pool, then
 * emit a claimable UTXO addressed to the destination.
 *
 * This is the "amount-hiding" path — the destination's ATA receipt has no
 * on-chain link to either the ephemeral's original balance amount or the
 * user's main wallet. The mixer's anonymity set is the set of all Umbra
 * users shielding/unshielding in the same time window.
 *
 * Fails gracefully: returns `{ ok: false, error }` if the SDK can't
 * initialize (devnet without contracts, indexer unreachable, etc.) — the
 * caller should then fall back to a plain SPL transfer.
 */
export async function shieldAndMoveViaMixer(params: {
  ephemeral: EphemeralWallet;
  destinationPubkey: string;   // base58 Solana address
  mint: string;                // token mint (USDC / YES / NO)
  amount: bigint;              // base units
}): Promise<{ ok: boolean; error?: string; commitment?: string }> {
  const initialized = await getUmbraClientFromEphemeral(params.ephemeral);
  if (!initialized) {
    return { ok: false, error: "Umbra unavailable — falling back to direct transfer" };
  }
  const { client, sdk } = initialized as any;

  try {
    // Ensure the ephemeral is registered in the Umbra protocol (idempotent).
    const register = sdk.getUserRegistrationFunction({ client });
    await register({ confidential: true, anonymous: true });

    // Shield ephemeral's public balance → UTXO claimable by destination.
    // Combines both halves of the Phase B flow in one SDK call: the tokens
    // leave the ephemeral's ATA (shield op) and land as a claimable UTXO
    // addressed to `destinationPubkey` in the Umbra pool, which destination
    // can then claim out to its own public balance whenever it wants.
    const createUtxo = sdk.getPublicBalanceToReceiverClaimableUtxoCreatorFunction({ client });
    const result = await createUtxo({
      receiverAddress: params.destinationPubkey,
      mint: params.mint,
      amount: params.amount,
    });

    return { ok: true, commitment: result?.utxoCommitment };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Umbra shield+move failed" };
  }
}

// ══════════════════════════════════════════════════════════════════════
//  Move-to-address: pull tokens from an ephemeral ATA → destination
// ══════════════════════════════════════════════════════════════════════

/**
 * Load the ephemeral Keypair by public key. Returns null if not found in
 * local storage (browser reset, different machine, etc).
 */
export async function getEphemeralKeypair(
  userWallet: string,
  ephemeralPubkey: string,
) {
  const { Keypair } = await import("@solana/web3.js");
  const bs58mod = await import("bs58");
  const bs58 = (bs58mod as any).default ?? bs58mod;
  const list = getEphemeralWallets(userWallet);
  const eph = list.find((e) => e.publicKey === ephemeralPubkey);
  if (!eph) return null;
  return Keypair.fromSecretKey(bs58.decode(eph.secretKey));
}

export interface MoveResult {
  ok: boolean;
  signature?: string;
  error?: string;
  /** Amount moved (base units, accounting for token decimals). */
  amountMoved?: bigint;
  /** Destination pubkey (base58) if auto-generated as a fresh wallet. */
  freshDestination?: string;
}

/**
 * Move tokens from an ephemeral's ATA to a destination pubkey's ATA.
 *
 * The ephemeral signs the SPL transfer; the relayer sponsors the fee via
 * `POST /sponsor-fee`. This keeps the ephemeral from needing any SOL of its
 * own (it never did, post-creation).
 *
 * For "via mixer" behavior (amount-hiding unlink, not just destination-
 * unlink), pass `viaMixer: true` — attempts to route through Umbra's
 * internal-transfer path using a keypair→wallet-standard adapter. Falls
 * back to plain transfer if Umbra is unavailable.
 *
 * Default semantics:
 *   - If `amount` is undefined, moves the entire ATA balance ("MAX").
 *   - If the destination ATA doesn't exist, includes the create-ATA ix.
 *   - `freshDestination: true` generates a new Keypair to destination,
 *     breaks ephemeral→identity correlation entirely.
 */
export async function moveFromEphemeral(params: {
  userWallet: string;
  ephemeralPubkey: string;
  destination?: string;         // base58; if omitted, generates a fresh wallet
  mint: string;                  // token mint (USDC / YES / NO)
  amount?: bigint;               // default: MAX (entire ATA balance)
  viaMixer?: boolean;            // attempt Umbra-routed path
  relayerUrl?: string;
  rpcUrl?: string;
}): Promise<MoveResult> {
  try {
    const {
      Connection, PublicKey, Keypair, Transaction, SystemProgram,
    } = await import("@solana/web3.js");
    const splToken = await import("@solana/spl-token");

    const ephemeralKp = await getEphemeralKeypair(params.userWallet, params.ephemeralPubkey);
    if (!ephemeralKp) {
      return { ok: false, error: "Ephemeral keypair not found in local storage" };
    }

    // Phase B amount-hiding path — if viaMixer is on, try the Umbra mixer
    // first. Needs destination resolved up-front (no deferred fresh-wallet
    // in this branch). If Umbra is unavailable (devnet without contracts),
    // fall through to the plain SPL path below.
    if (params.viaMixer) {
      const ephList = getEphemeralWallets(params.userWallet);
      const eph = ephList.find((e) => e.publicKey === params.ephemeralPubkey);
      if (!eph) {
        return { ok: false, error: "Ephemeral record not in local storage" };
      }
      // Resolve destination (plain or fresh-wallet) BEFORE routing.
      let destinationB58 = params.destination;
      let freshPk: string | undefined;
      if (!destinationB58) {
        const { Keypair } = await import("@solana/web3.js");
        const fresh = Keypair.generate();
        destinationB58 = fresh.publicKey.toBase58();
        freshPk = destinationB58;
      }
      // Need to know the amount — if undefined, query the ATA balance.
      let mixerAmount = params.amount;
      if (mixerAmount === undefined) {
        const { Connection, PublicKey } = await import("@solana/web3.js");
        const splToken = await import("@solana/spl-token");
        const rpcUrl = params.rpcUrl
          ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL
          ?? "https://api.devnet.solana.com";
        const connection = new Connection(rpcUrl, "confirmed");
        const sourceAta = await splToken.getAssociatedTokenAddress(
          new PublicKey(params.mint),
          new PublicKey(params.ephemeralPubkey),
        );
        try {
          const acct = await splToken.getAccount(connection, sourceAta);
          mixerAmount = acct.amount;
        } catch {
          return { ok: false, error: "Ephemeral ATA not found (no balance to move via mixer)" };
        }
      }
      if (mixerAmount === 0n) return { ok: false, error: "No balance in ephemeral ATA" };

      const mixerResult = await shieldAndMoveViaMixer({
        ephemeral: eph,
        destinationPubkey: destinationB58,
        mint: params.mint,
        amount: mixerAmount,
      });
      if (mixerResult.ok) {
        return {
          ok: true,
          signature: mixerResult.commitment, // Umbra UTXO commitment — not a Solana tx sig
          amountMoved: mixerAmount,
          freshDestination: freshPk,
        };
      }
      // Mixer path failed → log + fall through to plain SPL transfer.
      console.warn("[Predacy] viaMixer unavailable, falling back to plain transfer:", mixerResult.error);
    }

    const relayerUrl = params.relayerUrl
      ?? process.env.NEXT_PUBLIC_RELAYER_URL
      ?? "http://localhost:3001";

    // Health check — need the relayer's pubkey as fee payer
    const healthRes = await fetch(`${relayerUrl}/health`);
    if (!healthRes.ok) return { ok: false, error: "Relayer unreachable (no fee sponsor)" };
    const { relayer: relayerPk } = await healthRes.json();
    const feePayer = new PublicKey(relayerPk);

    const rpcUrl = params.rpcUrl
      ?? process.env.NEXT_PUBLIC_SOLANA_RPC_URL
      ?? "https://api.devnet.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    const mint = new PublicKey(params.mint);

    // Auto-generate a fresh destination wallet if none provided — the
    // strongest privacy path, since the destination has no prior activity
    // linkable to anything.
    let destinationPubkey: InstanceType<typeof PublicKey>;
    let freshDestination: string | undefined;
    if (params.destination) {
      destinationPubkey = new PublicKey(params.destination);
    } else {
      const fresh = Keypair.generate();
      destinationPubkey = fresh.publicKey;
      freshDestination = destinationPubkey.toBase58();
    }

    // Resolve source + destination ATAs
    const sourceAta = await splToken.getAssociatedTokenAddress(mint, ephemeralKp.publicKey);
    const destAta = await splToken.getAssociatedTokenAddress(mint, destinationPubkey);

    // Query source balance; default amount = MAX
    let amount = params.amount;
    if (amount === undefined) {
      try {
        const acct = await splToken.getAccount(connection, sourceAta);
        amount = acct.amount;
      } catch {
        return { ok: false, error: "Ephemeral ATA not found (no balance to move)" };
      }
    }
    if (amount === 0n) return { ok: false, error: "No balance in ephemeral ATA" };

    // Build the tx: optionally create dest ATA, then transfer
    const tx = new Transaction();
    tx.feePayer = feePayer;
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    // Create destination ATA if missing (fee payer = relayer pays rent)
    const destInfo = await connection.getAccountInfo(destAta);
    if (!destInfo) {
      tx.add(
        splToken.createAssociatedTokenAccountInstruction(
          feePayer,            // payer (relayer)
          destAta,              // ata to create
          destinationPubkey,    // owner of the ATA
          mint,
        ),
      );
    }

    // Transfer
    tx.add(
      splToken.createTransferInstruction(
        sourceAta,               // from
        destAta,                 // to
        ephemeralKp.publicKey,   // authority
        amount,                  // amount (base units)
      ),
    );

    // Ephemeral signs its part
    tx.partialSign(ephemeralKp);

    // Serialize (skip signature verification — fee payer hasn't signed yet)
    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base64 = Buffer.from(serialized).toString("base64");

    // Send to relayer for fee-payer co-sign + submit
    const res = await fetch(`${relayerUrl}/sponsor-fee`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transaction: base64,
        ephemeralPubkey: ephemeralKp.publicKey.toBase58(),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }

    // viaMixer=true takes the Umbra path up above via shieldAndMoveViaMixer;
    // reaching here means either viaMixer=false or the mixer attempt
    // degraded to this plain SPL transfer.

    return {
      ok: true,
      signature: data.signature,
      amountMoved: amount,
      freshDestination,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Move failed" };
  }
}
