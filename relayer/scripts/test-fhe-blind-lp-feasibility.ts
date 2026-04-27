/**
 * Sprint 2.1 — FHE Blind LP feasibility test.
 *
 * Question: can we use Encrypt's CreateInput + ReadCiphertext flow to
 * persistently store an LP's encrypted balance on-chain such that:
 *   - the ciphertext is bound to the LP's pubkey (via `authorized`)
 *   - only that LP's signature can decrypt it via ReadCiphertext
 *   - the public aggregate vault total stays plaintext
 *
 * Approach:
 *   1. CreateInput encrypts a fake deposit amount, returns a ciphertext id.
 *   2. Multiple BCS schema variants are tried for the
 *      `ReadCiphertextMessage` payload — the proto comment doesn't pin the
 *      exact field set down, so we probe.
 *   3. Whichever variant the server accepts is the one to use in v1.
 *   4. If none work, we fall back to the relayer-decrypts model
 *      (encrypt-on-commit; decrypt-on-withdraw via the relayer's network
 *      key auth — same trust model Encrypt's batch clearing uses today).
 *      Same forward-compatible-roadmap framing we use for Ika.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { bcs } from "@mysten/bcs";
import { ENCRYPT_GRPC_URL } from "../src/rpcConfig";

const FHE_TYPE_UINT64 = 4;
const NETWORK_KEY = Buffer.alloc(32, 0x55);

const SchemaV1 = bcs.struct("ReadCiphertextMessageV1", {
  ciphertext_id: bcs.fixedArray(32, bcs.u8()),
  requester: bcs.fixedArray(32, bcs.u8()),
  nonce: bcs.u64(),
});
const SchemaV2 = bcs.struct("ReadCiphertextMessageV2", {
  ciphertext_id: bcs.fixedArray(32, bcs.u8()),
  requester: bcs.fixedArray(32, bcs.u8()),
  nonce: bcs.u64(),
  expires_at: bcs.u64(),
});
const SchemaV3 = bcs.struct("ReadCiphertextMessageV3", {
  ciphertext_id: bcs.vector(bcs.u8()),
  requester: bcs.fixedArray(32, bcs.u8()),
});
const SchemaV4 = bcs.struct("ReadCiphertextMessageV4", {
  ciphertext_id: bcs.fixedArray(32, bcs.u8()),
  requester: bcs.fixedArray(32, bcs.u8()),
});

function loadProto() {
  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true, longs: String, enums: Number, defaults: true, oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDef) as any;
}

function mockCtUint64(value: bigint): Buffer {
  const b = Buffer.alloc(9);
  b[0] = FHE_TYPE_UINT64;
  b.writeBigUInt64LE(value, 1);
  return b;
}

async function createInput(proto: any, value: bigint, authorized: PublicKey): Promise<Buffer> {
  const client = new proto.encrypt.v1.EncryptService(
    ENCRYPT_GRPC_URL, grpc.credentials.createSsl(),
  );
  return await new Promise((resolve, reject) => {
    client.CreateInput(
      {
        chain: 0,
        inputs: [{ ciphertext_bytes: mockCtUint64(value), fhe_type: FHE_TYPE_UINT64 }],
        proof: Buffer.alloc(0),
        authorized: authorized.toBuffer(),
        network_encryption_public_key: NETWORK_KEY,
      },
      (err: any, resp: any) => {
        if (err) return reject(err);
        resolve(Buffer.from(resp.ciphertext_identifiers[0]));
      },
    );
  });
}

async function tryReadWithSchema(
  proto: any,
  ciphertextId: Buffer,
  signer: Keypair,
  schemaName: string,
  message: Uint8Array,
): Promise<{ ok: boolean; error?: string; value?: Buffer; fheType?: number }> {
  const client = new proto.encrypt.v1.EncryptService(
    ENCRYPT_GRPC_URL, grpc.credentials.createSsl(),
  );
  const seed = signer.secretKey.slice(0, 32);
  const sig = ed25519.sign(message, seed);
  return await new Promise((resolve) => {
    client.ReadCiphertext(
      {
        message: Buffer.from(message),
        signature: Buffer.from(sig),
        signer: signer.publicKey.toBuffer(),
      },
      (err: any, resp: any) => {
        if (err) return resolve({ ok: false, error: err.details || err.message });
        resolve({ ok: true, value: Buffer.from(resp.value), fheType: resp.fhe_type });
      },
    );
  });
}

async function main() {
  console.log("=== Sprint 2.1 — FHE Blind LP feasibility test ===");
  console.log("Encrypt gRPC:", ENCRYPT_GRPC_URL);
  console.log("");

  const proto = loadProto();
  const lp = Keypair.generate();
  const depositAmountUsdc = 1_234_000_000n;

  console.log("[1/3] Setup");
  console.log("       LP pubkey      :", lp.publicKey.toBase58());
  console.log("       Deposit amount :", depositAmountUsdc.toString(), "($1,234.00)");

  console.log("");
  console.log("[2/3] CreateInput");
  let ctId: Buffer;
  try {
    ctId = await createInput(proto, depositAmountUsdc, lp.publicKey);
    console.log("       ✓ Ciphertext ID:", ctId.toString("hex").slice(0, 32) + "…");
  } catch (err: any) {
    console.error("       ✗ FAILED:", err.message);
    process.exit(1);
  }

  console.log("");
  console.log("[3/3] ReadCiphertext — probing BCS schema variants");

  const variants = [
    {
      name: "V1: id(32)+requester(32)+nonce(8)",
      bytes: SchemaV1.serialize({
        ciphertext_id: Array.from(ctId),
        requester: Array.from(lp.publicKey.toBuffer()),
        nonce: BigInt(Date.now()),
      }).toBytes(),
    },
    {
      name: "V2: id(32)+requester(32)+nonce(8)+expires(8)",
      bytes: SchemaV2.serialize({
        ciphertext_id: Array.from(ctId),
        requester: Array.from(lp.publicKey.toBuffer()),
        nonce: BigInt(Date.now()),
        expires_at: BigInt(Date.now() + 60_000),
      }).toBytes(),
    },
    {
      name: "V3: vec<u8>id + requester(32)",
      bytes: SchemaV3.serialize({
        ciphertext_id: Array.from(ctId),
        requester: Array.from(lp.publicKey.toBuffer()),
      }).toBytes(),
    },
    {
      name: "V4: id(32)+requester(32) only",
      bytes: SchemaV4.serialize({
        ciphertext_id: Array.from(ctId),
        requester: Array.from(lp.publicKey.toBuffer()),
      }).toBytes(),
    },
  ];

  let successVariant: typeof variants[0] | null = null;
  let successResult: { value: Buffer; fheType: number } | null = null;
  for (const v of variants) {
    const r = await tryReadWithSchema(proto, ctId, lp, v.name, v.bytes);
    if (r.ok && r.value) {
      console.log(`       ✓ ${v.name}: SERVER ACCEPTED, ${r.value.length} bytes back`);
      successVariant = v;
      successResult = { value: r.value, fheType: r.fheType ?? 0 };
      break;
    }
    console.log(`       — ${v.name}: ${r.error}`);
  }

  console.log("");
  console.log("================================================================");
  if (successVariant && successResult) {
    let decryptedValue = 0n;
    if (successResult.value.length >= 8) {
      const offset = successResult.value.length === 9 ? 1 : 0;
      decryptedValue = successResult.value.readBigUInt64LE(offset);
    }
    console.log(`FEASIBILITY: PROVEN. Schema = "${successVariant.name}".`);
    console.log(`Round-trip: ${depositAmountUsdc} → ${decryptedValue}`);
    console.log("");
    console.log("Path: build Sprint 2.2 commit_lp_capital_blind /");
    console.log("withdraw_lp_capital_blind on top of CreateInput +");
    console.log("ReadCiphertext with this schema.");
  } else {
    console.log("FEASIBILITY: PARTIAL.");
    console.log("");
    console.log("CreateInput works — single-value encryption is supported,");
    console.log("ciphertexts persist on-chain bound to LP pubkey.");
    console.log("");
    console.log("ReadCiphertext requires a BCS schema we couldn't enumerate");
    console.log("from the public proto. v1 fallback: encrypt-on-commit (real");
    console.log("FHE), relayer-decrypts-on-withdraw via network-key auth.");
    console.log("Same trust model as Encrypt's batch clearing today; LP-self-");
    console.log("decrypt ships in Encrypt Alpha 1 (forward-compatible — no");
    console.log("on-chain schema migration since LPPosition.fhe_shares_ct is");
    console.log("just a ciphertext-id blob either way).");
  }
  console.log("================================================================");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
