/**
 * Blind LP — relayer-side encryption pipeline for the Tier 1 Blind LP
 * deposit flow (docs/LIQUIDITY.md §7, Sprint 2).
 *
 *   1. Frontend calls POST /lp/commit-blind with { handleIdHex, depositor,
 *      amount, commitmentExpiresAt }.
 *   2. Relayer calls Encrypt's gRPC CreateInput to encrypt `amount`
 *      authorized=depositor pubkey, returning a 32-byte ciphertext id.
 *   3. Relayer builds an unsigned commit_lp_capital_blind tx that includes
 *      the ciphertext id as an instruction arg.
 *   4. Frontend signs + submits.
 *
 * v1 trust model: relayer holds Encrypt's network key, so it can decrypt
 * any ciphertext via the existing batch-clearing flow at withdraw time.
 * Identical to Encrypt's batch clearing trust model in production today.
 *
 * Alpha 1 upgrade: gRPC ReadCiphertext (LP-self-authenticated decryption)
 * replaces the relayer-decrypt path. No on-chain layout change since
 * LPPosition.fhe_shares_ct is just a 32-byte ciphertext id either way.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { ENCRYPT_GRPC_URL } from "./rpcConfig";

const FHE_TYPE_UINT64 = 4;
/** Mock network key the Encrypt pre-Alpha dev mode accepts. */
const NETWORK_KEY = Buffer.alloc(32, 0x55);

let cachedProto: any = null;
function loadProto() {
  if (cachedProto) return cachedProto;
  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
  });
  cachedProto = grpc.loadPackageDefinition(packageDef);
  return cachedProto;
}

/** Pre-Alpha dev-mode ciphertext format: type-tag byte + LE u64 value. */
function mockCtUint64(value: bigint): Buffer {
  const b = Buffer.alloc(9);
  b[0] = FHE_TYPE_UINT64;
  b.writeBigUInt64LE(value, 1);
  return b;
}

export interface BlindLpEncryptResult {
  /** 32-byte on-chain ciphertext id — goes into LPPosition.fhe_shares_ct. */
  ciphertextId: Buffer;
  /** Echo of the encrypted value, for the relayer's audit log only. The
   *  on-chain side never sees this. */
  plaintextEcho: bigint;
}

/**
 * Encrypt a deposit amount via Encrypt's CreateInput gRPC. Returns the
 * ciphertext id to embed in `commit_lp_capital_blind`.
 *
 * `authorizedDepositor` is who's allowed to read the ciphertext via
 * ReadCiphertext later (Alpha 1 path) — set to the LP's pubkey.
 */
export async function encryptDepositAmount(
  amount: bigint,
  authorizedDepositor: PublicKey,
): Promise<BlindLpEncryptResult> {
  if (amount <= 0n) {
    throw new Error(`encryptDepositAmount: amount must be > 0, got ${amount}`);
  }
  const proto = loadProto();
  const client = new proto.encrypt.v1.EncryptService(
    ENCRYPT_GRPC_URL,
    grpc.credentials.createSsl(),
  );

  const ciphertextId = await new Promise<Buffer>((resolve, reject) => {
    client.CreateInput(
      {
        chain: 0,
        inputs: [
          {
            ciphertext_bytes: mockCtUint64(amount),
            fhe_type: FHE_TYPE_UINT64,
          },
        ],
        proof: Buffer.alloc(0),
        authorized: authorizedDepositor.toBuffer(),
        network_encryption_public_key: NETWORK_KEY,
      },
      (err: any, resp: any) => {
        if (err) return reject(new Error(`CreateInput failed: ${err.details || err.message}`));
        if (!resp.ciphertext_identifiers || resp.ciphertext_identifiers.length !== 1) {
          return reject(
            new Error(
              `CreateInput returned ${resp.ciphertext_identifiers?.length ?? 0} ids; expected 1`,
            ),
          );
        }
        const idBytes = Buffer.from(resp.ciphertext_identifiers[0]);
        if (idBytes.length !== 32) {
          return reject(
            new Error(`CreateInput ciphertext id is ${idBytes.length} bytes; expected 32`),
          );
        }
        resolve(idBytes);
      },
    );
  });

  console.log(
    `[BlindLP] Encrypted $${(Number(amount) / 1e6).toFixed(2)} for depositor ${authorizedDepositor.toBase58().slice(0, 8)}…` +
      ` ct=${ciphertextId.toString("hex").slice(0, 16)}…`,
  );

  return { ciphertextId, plaintextEcho: amount };
}

/**
 * Health probe for the Blind LP gRPC path. Used by /health to surface
 * whether the encryption pipeline is reachable. Doesn't mutate state.
 */
export async function probeBlindLpReachable(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const proto = loadProto();
    const client = new proto.encrypt.v1.EncryptService(
      ENCRYPT_GRPC_URL,
      grpc.credentials.createSsl(),
    );
    await new Promise<void>((resolve, reject) => {
      const deadline = new Date(Date.now() + 3000);
      client.waitForReady(deadline, (err: any) => (err ? reject(err) : resolve()));
    });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}
