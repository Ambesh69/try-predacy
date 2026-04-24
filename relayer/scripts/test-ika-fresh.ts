/**
 * Fresh-keypair Ika Sign test — mirrors dwallet-labs/ika-pre-alpha
 * _shared/ika-setup.ts pattern as closely as possible, using a brand-new
 * payer keypair (funded from our relayer) per run.
 *
 * Hypothesis: Pre-Alpha's mock signer registers keys PER-PAYER and only
 * produces signatures when DKG → Presign → Sign use matching session_id
 * patterns.  Our production flow reuses the relayer keypair and uses
 * different session_id patterns than the voting example — possibly why
 * our Sign fails with "no key for dwallet."
 *
 * Run: `npx ts-node scripts/test-ika-fresh.ts`
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { bcs } from "@mysten/bcs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { keccak_256 } from "@noble/hashes/sha3.js";
// bs58 has no types in this env — require dynamically
const bs58: any = require("bs58");

// ── Config ───────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_FAST_API_KEY
  ? `${process.env.RPC_FAST_HTTP_URL}/?api_key=${process.env.RPC_FAST_API_KEY}`
  : "https://api.devnet.solana.com";
const GRPC_URL = "pre-alpha-dev-1.ika.ika-network.net:443";
const IKA_PROGRAM = new PublicKey("87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY");
const PREDACY_PROGRAM = new PublicKey("Bb3zRkLip445BQ1S44PC115aws8CCyag4KFkch9ZcKjp");

// ── Constants from _shared/ika-setup.ts ──────────────────────────────

const SEED_DWALLET = Buffer.from("dwallet");
const SEED_MESSAGE_APPROVAL = Buffer.from("message_approval");
const SEED_CPI_AUTHORITY = Buffer.from("__ika_cpi_authority");
const SEED_COORDINATOR = Buffer.from("dwallet_coordinator");
const IX_TRANSFER_OWNERSHIP = 24;
const CURVE_CURVE25519 = 2;
const DISC_DWALLET = 2;

// ── BCS types (match _shared/ika-setup.ts + ika-dwallet-types Rust source) ──

const ChainId = bcs.enum("ChainId", { Solana: null, Sui: null });
const DWalletCurve = bcs.enum("DWalletCurve", { Secp256k1: null, Secp256r1: null, Curve25519: null, Ristretto: null });
const DWalletSignatureAlgorithm = bcs.enum("DWalletSignatureAlgorithm", { ECDSASecp256k1: null, ECDSASecp256r1: null, Taproot: null, EdDSA: null, SchnorrkelSubstrate: null });
const DWalletSignatureScheme = bcs.enum("DWalletSignatureScheme", { EcdsaKeccak256: null, EcdsaSha256: null, EcdsaDoubleSha256: null, TaprootSha256: null, EcdsaBlake2b256: null, EddsaSha512: null, SchnorrkelMerlin: null });
const ApprovalProof = bcs.enum("ApprovalProof", {
  Solana: bcs.struct("ApprovalProofSolana", { transaction_signature: bcs.vector(bcs.u8()), slot: bcs.u64() }),
  Sui: bcs.struct("ApprovalProofSui", { effects_certificate: bcs.vector(bcs.u8()) }),
});
const UserSignature = bcs.enum("UserSignature", {
  Ed25519: bcs.struct("UserSignatureEd25519", { signature: bcs.vector(bcs.u8()), public_key: bcs.vector(bcs.u8()) }),
  Secp256k1: bcs.struct("UserSignatureSecp256k1", { signature: bcs.vector(bcs.u8()), public_key: bcs.vector(bcs.u8()) }),
  Secp256r1: bcs.struct("UserSignatureSecp256r1", { signature: bcs.vector(bcs.u8()), public_key: bcs.vector(bcs.u8()) }),
});
const NetworkSignedAttestation = bcs.struct("NetworkSignedAttestation", {
  attestation_data: bcs.vector(bcs.u8()),
  network_signature: bcs.vector(bcs.u8()),
  network_pubkey: bcs.vector(bcs.u8()),
  epoch: bcs.u64(),
});
const UserSecretKeyShare = bcs.enum("UserSecretKeyShare", {
  Encrypted: bcs.struct("UserSecretKeyShareEncrypted", { encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()), encryption_key: bcs.vector(bcs.u8()), signer_public_key: bcs.vector(bcs.u8()) }),
  Public: bcs.struct("UserSecretKeySharePublic", { public_user_secret_key_share: bcs.vector(bcs.u8()) }),
});
const SignDuringDKGRequest = bcs.struct("SignDuringDKGRequest", {
  presign_session_identifier: bcs.vector(bcs.u8()), presign: bcs.vector(bcs.u8()),
  signature_scheme: DWalletSignatureScheme, message: bcs.vector(bcs.u8()),
  message_metadata: bcs.vector(bcs.u8()), message_centralized_signature: bcs.vector(bcs.u8()),
});

// Full 11-variant enum (order matters!)
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
  ImportedKeySign: bcs.struct("ImportedKeySign", {
    message: bcs.vector(bcs.u8()), message_metadata: bcs.vector(bcs.u8()),
    presign_session_identifier: bcs.vector(bcs.u8()), message_centralized_signature: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation, approval_proof: ApprovalProof,
  }),
  Presign: bcs.struct("Presign", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    curve: DWalletCurve, signature_algorithm: DWalletSignatureAlgorithm,
  }),
  PresignForDWallet: bcs.struct("PresignForDWallet", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    dwallet_public_key: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation,
    curve: DWalletCurve, signature_algorithm: DWalletSignatureAlgorithm,
  }),
  ImportedKeyVerification: bcs.struct("ImportedKeyVerification", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    curve: DWalletCurve, centralized_party_message: bcs.vector(bcs.u8()),
    user_secret_key_share: UserSecretKeyShare, user_public_output: bcs.vector(bcs.u8()),
  }),
  ReEncryptShare: bcs.struct("ReEncryptShare", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    dwallet_public_key: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation,
    encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()),
    encryption_key: bcs.vector(bcs.u8()),
  }),
  MakeSharePublic: bcs.struct("MakeSharePublic", {
    dwallet_public_key: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation,
    public_user_secret_key_share: bcs.vector(bcs.u8()),
  }),
  FutureSign: bcs.struct("FutureSign", {
    dwallet_public_key: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation,
    presign_session_identifier: bcs.vector(bcs.u8()),
    message: bcs.vector(bcs.u8()), message_metadata: bcs.vector(bcs.u8()),
    message_centralized_signature: bcs.vector(bcs.u8()),
    signature_scheme: DWalletSignatureScheme,
  }),
  SignWithPartialUserSig: bcs.struct("SignWithPartialUserSig", {
    partial_user_signature_attestation: NetworkSignedAttestation,
    dwallet_attestation: NetworkSignedAttestation, approval_proof: ApprovalProof,
  }),
  ImportedKeySignWithPartialUserSig: bcs.struct("ImportedKeySignWithPartialUserSig", {
    partial_user_signature_attestation: NetworkSignedAttestation,
    dwallet_attestation: NetworkSignedAttestation, approval_proof: ApprovalProof,
  }),
});

const SignedRequestData = bcs.struct("SignedRequestData", {
  session_identifier_preimage: bcs.fixedArray(32, bcs.u8()),
  epoch: bcs.u64(), chain_id: ChainId,
  intended_chain_sender: bcs.vector(bcs.u8()),
  request: DWalletRequest,
});
const TransactionResponseData = bcs.enum("TransactionResponseData", {
  Signature: bcs.struct("SignatureResponse", { signature: bcs.vector(bcs.u8()) }),
  Attestation: NetworkSignedAttestation,
  Error: bcs.struct("ErrorResponse", { message: bcs.string() }),
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

function buildUserSignature(payer: Keypair): Uint8Array {
  return UserSignature.serialize({
    Ed25519: {
      signature: Array.from(new Uint8Array(64)),
      public_key: Array.from(payer.publicKey.toBytes()),
    },
  } as any).toBytes();
}

function loadGrpcClient(): any {
  const protoPath = path.resolve(__dirname, "..", "proto", "ika_dwallet.proto");
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  });
  const protoDesc = grpc.loadPackageDefinition(packageDef) as any;
  const DWalletService = protoDesc.ika.dwallet.v1.DWalletService;
  return new DWalletService(GRPC_URL, grpc.credentials.createSsl());
}

function grpcSubmit(client: any, userSig: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    client.SubmitTransaction(
      { user_signature: Buffer.from(userSig), signed_request_data: Buffer.from(data) },
      (err: any, response: any) => err ? reject(err) : resolve(response.response_data),
    );
  });
}

async function pollAccount(
  connection: Connection, pubkey: PublicKey,
  check: (data: Buffer) => boolean, timeoutMs = 30_000, intervalMs = 500,
): Promise<Buffer> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await connection.getAccountInfo(pubkey);
    if (info && check(info.data)) return info.data;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollAccount timeout ${pubkey.toBase58()}`);
}

async function sendAndConfirm(connection: Connection, ixs: TransactionInstruction[], signers: Keypair[]): Promise<{ sig: string; slot: number }> {
  const tx = new Transaction().add(...ixs);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");
  const info = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { sig, slot: info?.slot ?? 0 };
}

// ── Main test ────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔════ Fresh-keypair Ika Sign test ════╗\n");

  // Load relayer keypair (for funding the fresh payer)
  const relayerPath = process.env.RELAYER_KEYPAIR_PATH || path.join(process.env.HOME || "~", ".config/solana/id.json");
  const relayer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(relayerPath, "utf-8"))));
  console.log("Relayer:", relayer.publicKey.toBase58());

  // Load Predacy IDL + build Anchor program
  const idlPath = path.resolve(__dirname, "..", "predacy-idl.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  const connection = new Connection(RPC_URL, {
    commitment: "confirmed",
    httpHeaders: process.env.RPC_FAST_API_KEY ? { "X-Token": process.env.RPC_FAST_API_KEY } : undefined,
  });

  // Generate fresh payer keypair
  const payer = Keypair.generate();
  console.log("Fresh payer:", payer.publicKey.toBase58());

  // Fund it with 0.1 SOL
  console.log("Funding fresh payer with 0.1 SOL...");
  const fundRes = await sendAndConfirm(connection,
    [SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: payer.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL })],
    [relayer],
  );
  console.log("  Fund tx:", fundRes.sig);

  // ── 1. DKG ────────────────────────────────────────────────────────
  console.log("\n[1/5] DKG via gRPC (session_id = ALL ZEROS, matching voting example)");
  const grpcClient = loadGrpcClient();

  const dkgPayload = SignedRequestData.serialize({
    session_identifier_preimage: Array.from(new Uint8Array(32)) as any,  // ← all zeros
    epoch: 1n,
    chain_id: { Solana: true } as any,
    intended_chain_sender: Array.from(payer.publicKey.toBytes()),
    request: {
      DKG: {
        dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
        curve: { Curve25519: true } as any,
        centralized_public_key_share_and_proof: Array.from(new Uint8Array(32)),
        user_secret_key_share: {
          Encrypted: {
            encrypted_centralized_secret_share_and_proof: Array.from(new Uint8Array(32)),
            encryption_key: Array.from(new Uint8Array(32)),
            signer_public_key: Array.from(payer.publicKey.toBytes()),
          },
        } as any,
        user_public_output: Array.from(new Uint8Array(32)),
        sign_during_dkg_request: null,
      },
    } as any,
  }).toBytes();

  const dkgResp = await grpcSubmit(grpcClient, buildUserSignature(payer), dkgPayload);
  const dkgParsed = TransactionResponseData.parse(new Uint8Array(dkgResp)) as any;
  if (!dkgParsed.Attestation) throw new Error(`DKG failed: ${JSON.stringify(dkgParsed)}`);
  const att = dkgParsed.Attestation;
  const attInner = VersionedDWalletDataAttestation.parse(new Uint8Array(att.attestation_data)) as any;
  const publicKey = new Uint8Array(attInner.V1.public_key);
  const [dwalletPda] = PublicKey.findProgramAddressSync(dwalletPdaSeeds(CURVE_CURVE25519, publicKey), IKA_PROGRAM);
  await pollAccount(connection, dwalletPda, (d) => d.length > 2 && d[0] === DISC_DWALLET, 20_000);
  console.log("  dWallet PDA:", dwalletPda.toBase58());
  console.log("  pubkey:     ", Buffer.from(publicKey).toString("hex"));

  // ── 2. Transfer authority to Predacy CPI PDA ─────────────────────
  console.log("\n[2/5] Transfer authority to Predacy CPI PDA");
  const [cpiAuthority] = PublicKey.findProgramAddressSync([SEED_CPI_AUTHORITY], PREDACY_PROGRAM);
  const transferData = Buffer.alloc(33);
  transferData[0] = IX_TRANSFER_OWNERSHIP;
  cpiAuthority.toBuffer().copy(transferData, 1);
  const transferRes = await sendAndConfirm(connection,
    [new TransactionInstruction({
      programId: IKA_PROGRAM,
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }, { pubkey: dwalletPda, isSigner: false, isWritable: true }],
      data: transferData,
    })],
    [payer],
  );
  console.log("  Transfer tx:", transferRes.sig);

  // ── 3. predacy.approve_ika_message via CPI ───────────────────────
  console.log("\n[3/5] predacy.approve_ika_message (CPI creates MessageApproval PDA)");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const predacy = new anchor.Program(idl, provider);

  const message = Buffer.from("predacy ika fresh test v1");
  const digest = keccak_256(message);
  const sigScheme = 5; // EddsaSha512 for Curve25519
  const schemeBuf = Buffer.alloc(2); schemeBuf.writeUInt16LE(sigScheme, 0);
  const maSeeds = [...dwalletPdaSeeds(CURVE_CURVE25519, publicKey), SEED_MESSAGE_APPROVAL, schemeBuf, Buffer.from(digest)];
  const [messageApprovalPda, maBump] = PublicKey.findProgramAddressSync(maSeeds, IKA_PROGRAM);
  const [coordinator] = PublicKey.findProgramAddressSync([SEED_COORDINATOR], IKA_PROGRAM);

  const approveSig = await (predacy as any).methods
    .approveIkaMessage(
      Array.from(digest),
      Array.from(new Uint8Array(32)),
      Array.from(publicKey.slice(0, 32)),
      sigScheme,
      maBump,
    )
    .accounts({
      ikaProgram: IKA_PROGRAM,
      ikaCoordinator: coordinator,
      messageApproval: messageApprovalPda,
      dwallet: dwalletPda,
      cpiAuthority,
      predacyProgram: PREDACY_PROGRAM,
      payer: payer.publicKey,
    })
    .rpc();
  console.log("  Approve tx:", approveSig);
  await connection.confirmTransaction(approveSig, "confirmed");
  const approveTxInfo = await connection.getTransaction(approveSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const approveSlot = approveTxInfo?.slot ?? 0;
  console.log("  Slot:      ", approveSlot);
  console.log("  MA PDA:    ", messageApprovalPda.toBase58());

  // ── 4. Presign ────────────────────────────────────────────────────
  console.log("\n[4/5] Presign (session_id = payer pubkey, matching voting example)");
  const presignPayload = SignedRequestData.serialize({
    session_identifier_preimage: Array.from(payer.publicKey.toBytes()) as any,  // ← payer pk (like voting example)
    epoch: 1n,
    chain_id: { Solana: true } as any,
    intended_chain_sender: Array.from(payer.publicKey.toBytes()),
    request: {
      Presign: {
        dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
        curve: { Curve25519: true } as any,
        signature_algorithm: { EdDSA: true } as any,
      },
    } as any,
  }).toBytes();
  const presignResp = await grpcSubmit(grpcClient, buildUserSignature(payer), presignPayload);
  const presignParsed = TransactionResponseData.parse(new Uint8Array(presignResp)) as any;
  if (!presignParsed.Attestation) throw new Error(`Presign failed: ${JSON.stringify(presignParsed)}`);
  const presignInner = VersionedPresignDataAttestation.parse(new Uint8Array(presignParsed.Attestation.attestation_data)) as any;
  const presignId = new Uint8Array(presignInner.V1.presign_session_identifier);
  console.log("  Presign ID:", Buffer.from(presignId).toString("hex"));

  // ── 5. Sign ───────────────────────────────────────────────────────
  console.log("\n[5/5] Sign (the moment of truth)");
  const signPayload = SignedRequestData.serialize({
    session_identifier_preimage: Array.from(payer.publicKey.toBytes()) as any,  // ← payer pk
    epoch: 1n,
    chain_id: { Solana: true } as any,
    intended_chain_sender: Array.from(payer.publicKey.toBytes()),
    request: {
      Sign: {
        message: Array.from(message),
        message_metadata: [],
        presign_session_identifier: Array.from(presignId),
        message_centralized_signature: Array.from(new Uint8Array(64)),
        dwallet_attestation: {
          attestation_data: Array.from(att.attestation_data),
          network_signature: Array.from(att.network_signature),
          network_pubkey: Array.from(att.network_pubkey),
          epoch: BigInt(att.epoch),
        },
        approval_proof: {
          Solana: {
            transaction_signature: Array.from(bs58.decode(approveSig)),
            slot: BigInt(approveSlot),
          },
        } as any,
      },
    } as any,
  }).toBytes();

  const signResp = await grpcSubmit(grpcClient, buildUserSignature(payer), signPayload);
  const signParsed = TransactionResponseData.parse(new Uint8Array(signResp)) as any;
  if (signParsed.Signature) {
    console.log("\n╔════════════════════════════╗");
    console.log("║   🎉  SIGNATURE RECEIVED   ║");
    console.log("╚════════════════════════════╝");
    console.log("  sig:", Buffer.from(signParsed.Signature.signature).toString("hex"));
  } else if (signParsed.Error) {
    console.log("\n❌ Sign failed:", signParsed.Error.message);
  } else {
    console.log("\n❌ Unexpected sign response:", JSON.stringify(signParsed));
  }
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
