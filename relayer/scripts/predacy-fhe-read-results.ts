/**
 * Read the encrypted output ciphertexts from a successful settle_fhe_batch
 * via Encrypt's ReadCiphertext gRPC. In mock mode this returns the plaintext.
 *
 * Usage: pass the 4 output ciphertext pubkeys from the demo.
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ed25519 } from "@noble/curves/ed25519";
import * as fs from "fs";
import * as path from "path";

const ENCRYPT_GRPC_URL = "pre-alpha-dev-1.encrypt.ika-network.net:443";

// 4 output ciphertexts from the latest successful settle_fhe_batch
const OUTPUT_CTS: { pubkey: string; label: string }[] = [
  { pubkey: "7HN3LQrEQ6KZxB8bfo8vvBUWNN62BuyvTTe1M8MPfb8Z", label: "yes_buy_vol" },
  { pubkey: "2wmfXmxm1zXDkTfjp8XVa1NZsBn1TBWDWXrkcag5iozD", label: "no_buy_vol" },
  { pubkey: "EBdAoR7wder2XP6taed1YM17ydugZE1vEysZZAmv93nF", label: "yes_sell_qty" },
  { pubkey: "5gnCHDK65JwHdKAMFrXQhHT1YjUBQ1fBsmFe1dM1qCgY", label: "no_sell_qty" },
];

/** ReadCiphertextMessage — BCS-serialized.
 *  struct { chain: u32, ciphertext_identifier: Vec<u8>, reencryption_key: Vec<u8>, epoch: u64 }
 *  BCS encodes Vec<u8> as ULEB128(len) || bytes; u64/u32 little-endian.
 */
function bcsEncodeReadMessage(
  chain: number,
  ciphertextIdentifier: Buffer,
  reencryptionKey: Buffer,
  epoch: bigint,
): Buffer {
  const parts: Buffer[] = [];
  // chain: u8
  parts.push(Buffer.from([chain & 0xff]));
  // ciphertext_identifier: Vec<u8> (ULEB128 length prefix)
  parts.push(uleb128(ciphertextIdentifier.length));
  parts.push(ciphertextIdentifier);
  // reencryption_key: Vec<u8>
  parts.push(uleb128(reencryptionKey.length));
  parts.push(reencryptionKey);
  // epoch: u64
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(epoch);
  parts.push(epochBuf);
  return Buffer.concat(parts);
}

function uleb128(n: number): Buffer {
  const bytes: number[] = [];
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

async function readCiphertext(
  client: any,
  ctPubkey: PublicKey,
  signer: Keypair,
): Promise<{ value: Buffer; fheType: number; digest: Buffer }> {
  const reencryptionKey = Buffer.alloc(32, 0); // mock mode ignores
  const epoch = 0n;
  const message = bcsEncodeReadMessage(0, ctPubkey.toBuffer(), reencryptionKey, epoch);
  // Solana keypairs store secretKey as 64 bytes = 32-byte private + 32-byte public.
  // ed25519.sign expects only the 32-byte private seed.
  const privSeed = signer.secretKey.slice(0, 32);
  const signature = ed25519.sign(message, privSeed);

  return await new Promise((resolve, reject) => {
    client.ReadCiphertext(
      {
        message: message,
        signature: Buffer.from(signature),
        signer: signer.publicKey.toBuffer(),
      },
      { deadline: Date.now() + 30_000 },
      (err: any, response: any) => {
        if (err) {
          reject(new Error(`gRPC ReadCiphertext failed: ${err.code} ${err.message}`));
          return;
        }
        resolve({
          value: Buffer.from(response.value),
          fheType: response.fhe_type,
          digest: Buffer.from(response.digest),
        });
      },
    );
  });
}

async function main() {
  console.log("\n╔══ Reading FHE batch settlement outputs ══╗\n");

  const keypairPath = path.join(process.env.HOME!, ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

  const protoPath = path.join(__dirname, "..", "proto", "encrypt_service.proto");
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true, longs: String, enums: Number, defaults: true, oneofs: true,
  });
  const proto: any = grpc.loadPackageDefinition(packageDef);
  const ServiceClient = proto.encrypt.v1.EncryptService;
  const credentials = grpc.credentials.createSsl();
  const client = new ServiceClient(ENCRYPT_GRPC_URL, credentials);

  console.log(`gRPC: ${ENCRYPT_GRPC_URL}\n`);

  // Expected results given the demo's plaintexts:
  //   o0 YES_BUY  @0.60  100 USDC, clearing 0.55 → fills (0.60 ≥ 0.55) → yes_buy_vol += 100
  //   o1 YES_SELL @0.55   80 USDC                → fills (0.55 ≤ 0.55) → yes_sell_qty +=  80
  //   o2 NO_BUY   @0.45   60 USDC                → fills (0.45 + 0.55 = 1.00 ≥ 1.00) → no_buy_vol += 60
  //   o3 NO_SELL  @0.40   40 USDC                → fills (0.40 + 0.55 = 0.95 ≤ 1.00) → no_sell_qty += 40
  console.log("Expected (from clearing math):");
  console.log("  yes_buy_vol  = 100,000,000  (100 USDC)");
  console.log("  no_buy_vol   =  60,000,000  ( 60 USDC)");
  console.log("  yes_sell_qty =  80,000,000  ( 80 USDC)");
  console.log("  no_sell_qty  =  40,000,000  ( 40 USDC)\n");

  console.log("Reading from Encrypt's executor (mock-mode returns plaintext)…\n");

  for (const { pubkey, label } of OUTPUT_CTS) {
    try {
      const result = await readCiphertext(client, new PublicKey(pubkey), payer);
      // Mock-mode value bytes are the plaintext directly. For Uint64, parse 8 LE bytes.
      let plain: bigint;
      if (result.fheType === 4 && result.value.length === 8) {
        plain = result.value.readBigUInt64LE(0);
      } else {
        plain = BigInt("0x" + result.value.reverse().toString("hex"));
      }
      console.log(`  ${label.padEnd(14)} = ${plain.toString().padStart(15)}  (${result.value.toString("hex")})`);
    } catch (err: any) {
      console.log(`  ${label.padEnd(14)} = read failed: ${err.message}`);
    }
  }

  client.close();
}

main().catch((err) => {
  console.error("\n❌ FAILED:", err);
  process.exit(1);
});
