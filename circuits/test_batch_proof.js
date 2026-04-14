const snarkjs = require("snarkjs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Sample market and orders
  const marketId = BigInt("0x" + "ab".repeat(16)); // sample market ID
  const clearingPrice = 650000n; // $0.65

  // 2 real orders + 6 padding
  const orders = [
    { side: 0n, amount: 100000000n, limitPrice: 700000n, salt: 111n }, // YES_BUY at 70c — fills (>=65c)
    { side: 1n, amount: 50000000n, limitPrice: 600000n, salt: 222n },  // YES_SELL at 60c — fills (<=65c)
    // Padding (zero amount)
    { side: 0n, amount: 0n, limitPrice: 0n, salt: 0n },
    { side: 0n, amount: 0n, limitPrice: 0n, salt: 0n },
    { side: 0n, amount: 0n, limitPrice: 0n, salt: 0n },
    { side: 0n, amount: 0n, limitPrice: 0n, salt: 0n },
    { side: 0n, amount: 0n, limitPrice: 0n, salt: 0n },
    { side: 0n, amount: 0n, limitPrice: 0n, salt: 0n },
  ];

  // Compute commitments
  const commitments = orders.map(o => {
    const hash = poseidon([marketId, o.side, o.amount, o.limitPrice, o.salt]);
    return F.toObject(hash);
  });

  // Compute commitment root (sequential hash chain)
  let root = 0n;
  for (let i = 0; i < 8; i++) {
    const h = poseidon([root, commitments[i]]);
    root = F.toObject(h);
  }

  // Expected fills:
  // Order 0: YES_BUY, 700000 >= 650000 → fills, amount = 100000000
  // Order 1: YES_SELL, 600000 <= 650000 → fills, amount = 50000000
  const filledYesBuyVol = 100000000n;
  const filledNoBuyVol = 0n;
  const filledYesSellQty = 50000000n;
  const filledNoSellQty = 0n;

  const input = {
    commitmentRoot: root.toString(),
    clearingPrice: clearingPrice.toString(),
    filledYesBuyVol: filledYesBuyVol.toString(),
    filledNoBuyVol: filledNoBuyVol.toString(),
    filledYesSellQty: filledYesSellQty.toString(),
    filledNoSellQty: filledNoSellQty.toString(),
    orderCount: "2",
    marketId: marketId.toString(),
    sides: orders.map(o => o.side.toString()),
    amounts: orders.map(o => o.amount.toString()),
    limitPrices: orders.map(o => o.limitPrice.toString()),
    salts: orders.map(o => o.salt.toString()),
    commitments: commitments.map(c => c.toString()),
  };

  console.log("Generating batch clearing proof...");
  const wasmPath = path.join(__dirname, "batch_clearing/batch_clearing_js/batch_clearing.wasm");
  const zkeyPath = path.join(__dirname, "setup/batch_clearing_final.zkey");

  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const elapsed = Date.now() - startTime;

  console.log(`Proof generated in ${elapsed}ms`);
  console.log("Public signals:", publicSignals);

  // Verify
  const vkey = require("./setup/batch_clearing_vkey.json");
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("Proof valid:", valid);

  if (!valid) process.exit(1);
  console.log("\n✓ Batch clearing proof test passed!");
}

main().catch(e => { console.error(e); process.exit(1); });
