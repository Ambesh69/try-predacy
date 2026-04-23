/**
 * Ika Pre-Alpha dWallet manager (A1 — backend-delegated).
 *
 * Creates and operates dWallets on behalf of Predacy users so they don't
 * need Sui/Ika onboarding. Each user wallet address maps to a dWallet that
 * the relayer can drive. Architecture §4 (key material).
 *
 * Based on `chains/solana/examples/_shared/ika-setup.ts` in
 * dwallet-labs/ika-pre-alpha. That file is the canonical template — this
 * is an adaptation for multi-user server-side use.
 *
 * Pre-Alpha caveats:
 *   - Signing uses a single mock signer (not real 2PC-MPC). Real MPC in
 *     Alpha 1 when Ika mainnets. For the hackathon demo this is fine;
 *     the integration shape is correct.
 *   - All on-chain state will be wiped periodically by the Ika team.
 *   - Devnet-only (no mainnet yet from Ika's side).
 *
 * Endpoints:
 *   dWallet Solana program: 87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY
 *   Signing gRPC:          pre-alpha-dev-1.ika.ika-network.net:443
 *
 * Scope of this module:
 *   - DKG a user dWallet (Curve25519/EdDSA for Solana or Secp256k1/ECDSA
 *     for Polygon-compat signing)
 *   - Presign + Sign flow via gRPC
 *   - Persistent JSON store keyed by user wallet address
 *
 * Out of scope (separate work — Todo #18):
 *   - Our Predacy Anchor program CPI-calling approve_message
 *   - Authority transfer from relayer payer → Predacy CPI PDA
 */

import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { bcs } from "@mysten/bcs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { Config } from "./config";

// ── Constants mirrored from the Ika Pre-Alpha repo ───────────────────
// (See dwallet-labs/ika-pre-alpha/chains/solana/examples/_shared/ika-setup.ts)

const SEED_DWALLET_COORDINATOR = Buffer.from("dwallet_coordinator");
const SEED_DWALLET = Buffer.from("dwallet");
const DISC_COORDINATOR = 1;
const DISC_DWALLET = 2;
const DISC_NEK = 3;
const COORDINATOR_LEN = 116;
const NEK_LEN = 164;
const CURVE_CURVE25519 = 2;
const CURVE_SECP256K1 = 0;

// Default endpoints (override via env)
const IKA_PROGRAM_ID = "87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY";
const IKA_GRPC_URL = "pre-alpha-dev-1.ika.ika-network.net:443";

// ── BCS type definitions (must match crates/ika-dwallet-types/src/lib.rs) ──

const ChainId = bcs.enum("ChainId", { Solana: null, Sui: null });

const DWalletCurve = bcs.enum("DWalletCurve", {
  Secp256k1: null,
  Secp256r1: null,
  Curve25519: null,
  Ristretto: null,
});

const DWalletSignatureAlgorithm = bcs.enum("DWalletSignatureAlgorithm", {
  ECDSASecp256k1: null,
  ECDSASecp256r1: null,
  Taproot: null,
  EdDSA: null,
  SchnorrkelSubstrate: null,
});

const DWalletSignatureScheme = bcs.enum("DWalletSignatureScheme", {
  EcdsaKeccak256: null,
  EcdsaSha256: null,
  EcdsaDoubleSha256: null,
  TaprootSha256: null,
  EcdsaBlake2b256: null,
  EddsaSha512: null,
  SchnorrkelMerlin: null,
});

const ApprovalProof = bcs.enum("ApprovalProof", {
  Solana: bcs.struct("ApprovalProofSolana", {
    transaction_signature: bcs.vector(bcs.u8()),
    slot: bcs.u64(),
  }),
  Sui: bcs.struct("ApprovalProofSui", {
    effects_certificate: bcs.vector(bcs.u8()),
  }),
});

const UserSignature = bcs.enum("UserSignature", {
  Ed25519: bcs.struct("UserSignatureEd25519", {
    signature: bcs.vector(bcs.u8()),
    public_key: bcs.vector(bcs.u8()),
  }),
  Secp256k1: bcs.struct("UserSignatureSecp256k1", {
    signature: bcs.vector(bcs.u8()),
    public_key: bcs.vector(bcs.u8()),
  }),
  Secp256r1: bcs.struct("UserSignatureSecp256r1", {
    signature: bcs.vector(bcs.u8()),
    public_key: bcs.vector(bcs.u8()),
  }),
});

const NetworkSignedAttestation = bcs.struct("NetworkSignedAttestation", {
  attestation_data: bcs.vector(bcs.u8()),
  network_signature: bcs.vector(bcs.u8()),
  network_pubkey: bcs.vector(bcs.u8()),
  epoch: bcs.u64(),
});

const UserSecretKeyShare = bcs.enum("UserSecretKeyShare", {
  Encrypted: bcs.struct("UserSecretKeyShareEncrypted", {
    encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()),
    encryption_key: bcs.vector(bcs.u8()),
    signer_public_key: bcs.vector(bcs.u8()),
  }),
  Public: bcs.struct("UserSecretKeySharePublic", {
    public_user_secret_key_share: bcs.vector(bcs.u8()),
  }),
});

const SignDuringDKGRequest = bcs.struct("SignDuringDKGRequest", {
  presign_session_identifier: bcs.vector(bcs.u8()),
  presign: bcs.vector(bcs.u8()),
  signature_scheme: DWalletSignatureScheme,
  message: bcs.vector(bcs.u8()),
  message_metadata: bcs.vector(bcs.u8()),
  message_centralized_signature: bcs.vector(bcs.u8()),
});

const DWalletRequest = bcs.enum("DWalletRequest", {
  DKG: bcs.struct("DKG", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    curve: DWalletCurve,
    centralized_public_key_share_and_proof: bcs.vector(bcs.u8()),
    user_secret_key_share: UserSecretKeyShare,
    user_public_output: bcs.vector(bcs.u8()),
    sign_during_dkg_request: bcs.option(SignDuringDKGRequest),
  }),
  Sign: bcs.struct("Sign", {
    message: bcs.vector(bcs.u8()),
    message_metadata: bcs.vector(bcs.u8()),
    presign_session_identifier: bcs.vector(bcs.u8()),
    message_centralized_signature: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation,
    approval_proof: ApprovalProof,
  }),
  PresignForDWallet: bcs.struct("PresignForDWallet", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    dwallet_public_key: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation,
    curve: DWalletCurve,
    signature_algorithm: DWalletSignatureAlgorithm,
  }),
});

const SignedRequestData = bcs.struct("SignedRequestData", {
  session_identifier_preimage: bcs.fixedArray(32, bcs.u8()),
  epoch: bcs.u64(),
  chain_id: ChainId,
  intended_chain_sender: bcs.vector(bcs.u8()),
  request: DWalletRequest,
});

const TransactionResponseData = bcs.enum("TransactionResponseData", {
  Signature: bcs.struct("SignatureResponse", {
    signature: bcs.vector(bcs.u8()),
  }),
  Attestation: NetworkSignedAttestation,
  Error: bcs.struct("ErrorResponse", {
    message: bcs.string(),
  }),
});

const VersionedDWalletDataAttestation = bcs.enum("VersionedDWalletDataAttestation", {
  V1: bcs.struct("DWalletDataAttestationV1", {
    session_identifier: bcs.fixedArray(32, bcs.u8()),
    intended_chain_sender: bcs.vector(bcs.u8()),
    curve: DWalletCurve,
    public_key: bcs.vector(bcs.u8()),
    public_output: bcs.vector(bcs.u8()),
    is_imported_key: bcs.bool(),
    sign_during_dkg_signature: bcs.option(bcs.vector(bcs.u8())),
  }),
});

const VersionedPresignDataAttestation = bcs.enum("VersionedPresignDataAttestation", {
  V1: bcs.struct("PresignDataAttestationV1", {
    session_identifier: bcs.fixedArray(32, bcs.u8()),
    epoch: bcs.u64(),
    presign_session_identifier: bcs.vector(bcs.u8()),
    presign_data: bcs.vector(bcs.u8()),
    curve: DWalletCurve,
    signature_algorithm: DWalletSignatureAlgorithm,
    dwallet_public_key: bcs.option(bcs.vector(bcs.u8())),
    user_pubkey: bcs.vector(bcs.u8()),
  }),
});

// ── Persistent store ─────────────────────────────────────────────────

export type DWalletCurveName = "Curve25519" | "Secp256k1";

export interface UserDWalletRecord {
  userWallet: string;         // Solana user wallet address (Privy address)
  dwalletPda: string;         // on-chain dWallet PDA (base58)
  publicKey: string;          // dWallet public key (hex)
  curve: DWalletCurveName;
  attestation: string;        // base64 serialized NetworkSignedAttestation
  createdAt: number;
}

type Store = Record<string, UserDWalletRecord>;

// ── Helpers ──────────────────────────────────────────────────────────

function dwalletPdaSeeds(curve: number, publicKey: Uint8Array): Buffer[] {
  const payload = Buffer.alloc(2 + publicKey.length);
  payload.writeUInt16LE(curve, 0);
  Buffer.from(publicKey).copy(payload, 2);
  const seeds: Buffer[] = [SEED_DWALLET];
  for (let i = 0; i < payload.length; i += 32) {
    seeds.push(payload.subarray(i, Math.min(i + 32, payload.length)));
  }
  return seeds;
}

function curveEnumIndex(curve: DWalletCurveName): number {
  return curve === "Curve25519" ? CURVE_CURVE25519 : CURVE_SECP256K1;
}

function curveBcsTag(curve: DWalletCurveName): any {
  return curve === "Curve25519" ? { Curve25519: true } : { Secp256k1: true };
}

async function pollAccount(
  connection: Connection,
  pubkey: PublicKey,
  check: (data: Buffer) => boolean,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<Buffer> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await connection.getAccountInfo(pubkey);
    if (info && check(info.data)) return info.data;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollAccount timeout for ${pubkey.toBase58()}`);
}

async function findNekPda(
  connection: Connection,
  ikaProgramId: PublicKey,
): Promise<PublicKey> {
  const accounts = await connection.getProgramAccounts(ikaProgramId);
  const nek = accounts.find((a) => {
    const data = a.account.data as Buffer;
    return data.length >= NEK_LEN && data[0] === DISC_NEK;
  });
  if (!nek) throw new Error("Ika NetworkEncryptionKey account not found on-chain");
  return nek.pubkey;
}

// ── Main manager ─────────────────────────────────────────────────────

export class IkaManager {
  private config: Config;
  private storePath: string;
  private store: Store;
  private connection: Connection;
  private grpcClient: any | null = null;
  private ikaProgramId: PublicKey;
  private grpcUrl: string;
  private initialized = false;

  constructor(config: Config, connection: Connection) {
    this.config = config;
    this.connection = connection;
    this.storePath = path.join(
      process.env.IKA_STORE_PATH || path.join(path.dirname(config.idlPath), "..", "ika-dwallets.json"),
    );
    this.ikaProgramId = new PublicKey(process.env.IKA_PROGRAM_ID || IKA_PROGRAM_ID);
    this.grpcUrl = process.env.IKA_GRPC_URL || IKA_GRPC_URL;
    this.store = this.loadStore();
  }

  get enabled(): boolean {
    return process.env.IKA_ENABLED === "true";
  }

  getStoreSummary(): { users: number; enabled: boolean; programId: string; grpcUrl: string } {
    return {
      users: Object.keys(this.store).length,
      enabled: this.enabled,
      programId: this.ikaProgramId.toBase58(),
      grpcUrl: this.grpcUrl,
    };
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.enabled) {
      console.log("[ika] IKA_ENABLED=false — manager disabled");
      return;
    }
    const protoPath = path.join(__dirname, "..", "proto", "ika_dwallet.proto");
    const packageDef = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const protoDesc = grpc.loadPackageDefinition(packageDef) as any;
    const DWalletService = protoDesc.ika.dwallet.v1.DWalletService;
    // Port 443 → TLS is expected. The Pre-Alpha example uses createInsecure()
    // but that doesn't work against the public endpoint (it does for local
    // tests against localhost). Default to SSL for public endpoints; allow
    // override via IKA_GRPC_INSECURE=true for local dev.
    const useInsecure = process.env.IKA_GRPC_INSECURE === "true";
    const creds = useInsecure
      ? grpc.credentials.createInsecure()
      : grpc.credentials.createSsl();
    this.grpcClient = new DWalletService(
      this.grpcUrl.replace(/^https?:\/\//, ""),
      creds,
    );
    this.initialized = true;
    console.log(`[ika] Connected to ${this.grpcUrl} (${useInsecure ? "insecure" : "ssl"}), Solana program ${this.ikaProgramId.toBase58()}`);
  }

  /**
   * Create a dWallet for a user (idempotent). Uses Curve25519/EdDSA by
   * default — which gives us a Solana-compatible signing key. Pass
   * "Secp256k1" for Ethereum/Polygon signing.
   *
   * Requires: the relayer's keypair (`config.relayerKeypair`) to have
   * enough devnet SOL to pay for MessageApproval PDA rent (~0.001 SOL
   * per dWallet creation).
   */
  async ensureDWallet(
    userWallet: string,
    curve: DWalletCurveName = "Curve25519",
    payer?: Keypair,
  ): Promise<UserDWalletRecord> {
    const existing = this.store[userWallet];
    if (existing && existing.curve === curve) return existing;
    if (!this.enabled) throw new Error("IKA_ENABLED=false");
    await this.init();

    const payerKp = payer ?? this.config.relayerKeypair;

    // Wait for Ika coordinator account to be available on-chain.
    const [coordinatorPda] = PublicKey.findProgramAddressSync(
      [SEED_DWALLET_COORDINATOR],
      this.ikaProgramId,
    );
    await pollAccount(
      this.connection,
      coordinatorPda,
      (d) => d.length >= COORDINATOR_LEN && d[0] === DISC_COORDINATOR,
    );
    await findNekPda(this.connection, this.ikaProgramId);

    // Derive a per-user session identifier so concurrent users don't collide
    // in the Ika coordinator state. Pre-Alpha uses mock inputs (all-zero
    // secret shares) but the session ID must be distinct per call.
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const sessionId = sha256(Buffer.from(`predacy:${userWallet}:${curve}:${Date.now()}`));

    const dkgPayload = SignedRequestData.serialize({
      session_identifier_preimage: Array.from(sessionId) as any,
      epoch: 1n,
      chain_id: { Solana: true } as any,
      intended_chain_sender: Array.from(payerKp.publicKey.toBytes()),
      request: {
        DKG: {
          dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
          curve: curveBcsTag(curve) as any,
          centralized_public_key_share_and_proof: Array.from(new Uint8Array(32)),
          user_secret_key_share: {
            Encrypted: {
              encrypted_centralized_secret_share_and_proof: Array.from(new Uint8Array(32)),
              encryption_key: Array.from(new Uint8Array(32)),
              signer_public_key: Array.from(payerKp.publicKey.toBytes()),
            },
          } as any,
          user_public_output: Array.from(new Uint8Array(32)),
          sign_during_dkg_request: null,
        },
      } as any,
    }).toBytes();

    const userSig = UserSignature.serialize({
      Ed25519: {
        signature: Array.from(new Uint8Array(64)),
        public_key: Array.from(payerKp.publicKey.toBytes()),
      },
    } as any).toBytes();

    const responseBytes = await this.submitTransaction(userSig, dkgPayload);
    const response = TransactionResponseData.parse(new Uint8Array(responseBytes)) as any;
    if (!response.Attestation) {
      throw new Error(`DKG failed: ${JSON.stringify(response)}`);
    }
    const attestation = response.Attestation;
    const payload = VersionedDWalletDataAttestation.parse(
      new Uint8Array(attestation.attestation_data),
    ) as any;
    if (!payload.V1) throw new Error(`unexpected DKG payload: ${JSON.stringify(payload)}`);
    const publicKey = new Uint8Array(payload.V1.public_key);

    const [dwalletPda] = PublicKey.findProgramAddressSync(
      dwalletPdaSeeds(curveEnumIndex(curve), publicKey),
      this.ikaProgramId,
    );
    await pollAccount(
      this.connection,
      dwalletPda,
      (d) => d.length > 2 && d[0] === DISC_DWALLET,
      20_000,
    );

    const record: UserDWalletRecord = {
      userWallet,
      dwalletPda: dwalletPda.toBase58(),
      publicKey: Buffer.from(publicKey).toString("hex"),
      curve,
      attestation: Buffer.from(
        NetworkSignedAttestation.serialize(attestation).toBytes(),
      ).toString("base64"),
      createdAt: Date.now(),
    };
    this.store[userWallet] = record;
    this.saveStore();
    console.log(`[ika] dWallet created for ${userWallet.slice(0, 8)}… → ${record.dwalletPda.slice(0, 8)}…`);
    return record;
  }

  /**
   * Allocate a presign for the user's dWallet. Returns the opaque presign
   * session identifier to use in a subsequent sign call.
   */
  async requestPresign(userWallet: string): Promise<Uint8Array> {
    const record = this.store[userWallet];
    if (!record) throw new Error("No dWallet for user — call ensureDWallet first");
    await this.init();

    const payerKp = this.config.relayerKeypair;
    const publicKeyBytes = Uint8Array.from(Buffer.from(record.publicKey, "hex"));
    const attestation = NetworkSignedAttestation.parse(
      Uint8Array.from(Buffer.from(record.attestation, "base64")),
    ) as any;

    const payload = SignedRequestData.serialize({
      session_identifier_preimage: Array.from(publicKeyBytes.slice(0, 32)) as any,
      epoch: 1n,
      chain_id: { Solana: true } as any,
      intended_chain_sender: Array.from(payerKp.publicKey.toBytes()),
      request: {
        PresignForDWallet: {
          dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
          dwallet_public_key: Array.from(publicKeyBytes),
          dwallet_attestation: attestation,
          curve: curveBcsTag(record.curve) as any,
          signature_algorithm:
            record.curve === "Curve25519"
              ? ({ EdDSA: true } as any)
              : ({ ECDSASecp256k1: true } as any),
        },
      } as any,
    }).toBytes();

    const userSig = UserSignature.serialize({
      Ed25519: {
        signature: Array.from(new Uint8Array(64)),
        public_key: Array.from(payerKp.publicKey.toBytes()),
      },
    } as any).toBytes();

    const responseBytes = await this.submitTransaction(userSig, payload);
    const response = TransactionResponseData.parse(new Uint8Array(responseBytes)) as any;
    if (!response.Attestation) throw new Error(`Presign failed: ${JSON.stringify(response)}`);
    const presignPayload = VersionedPresignDataAttestation.parse(
      new Uint8Array(response.Attestation.attestation_data),
    ) as any;
    if (!presignPayload.V1) throw new Error(`unexpected presign payload`);
    return new Uint8Array(presignPayload.V1.presign_session_identifier);
  }

  // ── Internal: gRPC call wrapper ───────────────────────────────────

  private submitTransaction(
    userSignature: Uint8Array,
    signedRequestData: Uint8Array,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.grpcClient.SubmitTransaction(
        {
          user_signature: Buffer.from(userSignature),
          signed_request_data: Buffer.from(signedRequestData),
        },
        (err: any, response: any) => {
          if (err) reject(err);
          else resolve(response.response_data);
        },
      );
    });
  }

  // ── Storage ───────────────────────────────────────────────────────

  private loadStore(): Store {
    try {
      if (!fs.existsSync(this.storePath)) return {};
      return JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
    } catch (err: any) {
      console.warn("[ika] Failed to load store, starting fresh:", err.message);
      return {};
    }
  }

  private saveStore(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    } catch (err: any) {
      console.error("[ika] Failed to persist store:", err.message);
    }
  }
}

let instance: IkaManager | null = null;

export function getIkaManager(config: Config, connection: Connection): IkaManager {
  if (!instance) instance = new IkaManager(config, connection);
  return instance;
}
