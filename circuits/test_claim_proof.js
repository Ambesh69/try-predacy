const snarkjs = require("snarkjs");
const path = require("path");
const { buildPoseidon } = require("circomlibjs");

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const DEPTH = 9;
  const marketId = BigInt("0x" + "ab".repeat(16));
  const clearingPrice = 650000n;
  const batchId = 1n;

  // The order we're claiming (YES_BUY at 70c, fills at 65c clearing)
  const side = 0n; // YES_BUY
  const amount = 100000000n;
  const limitPrice = 700000n;
  const salt = 111n;
  const recipient = BigInt("0x" + "cd".repeat(16)); // payout address

  // Compute commitment
  const commitmentHash = poseidon([marketId, side, amount, limitPrice, salt]);
  const commitment = F.toObject(commitmentHash);

  // Build a simple Merkle tree with our commitment as leaf 0
  // Fill remaining leaves with zeros
  let leaves = new Array(1 << DEPTH).fill(0n);
  leaves[0] = commitment;

  // Build tree bottom-up
  let currentLevel = leaves;
  let tree = [currentLevel];
  for (let d = 0; d < DEPTH; d++) {
    let nextLevel = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const h = poseidon([currentLevel[i], currentLevel[i + 1]]);
      nextLevel.push(F.toObject(h));
    }
    currentLevel = nextLevel;
    tree.push(currentLevel);
  }
  const merkleRoot = tree[DEPTH][0];

  // Extract Merkle path for leaf index 0
  const merklePath = [];
  const merklePathIndices = [];
  let idx = 0;
  for (let d = 0; d < DEPTH; d++) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    merklePath.push(tree[d][siblingIdx].toString());
    merklePathIndices.push((idx % 2).toString()); // 0 = left, 1 = right
    idx = Math.floor(idx / 2);
  }

  // Compute nullifier
  const nullifierHash = poseidon([commitment, batchId, salt]);
  const nullifier = F.toObject(nullifierHash);

  const input = {
    batchId: batchId.toString(),
    claimMerkleRoot: merkleRoot.toString(),
    clearingPrice: clearingPrice.toString(),
    nullifier: nullifier.toString(),
    recipient: recipient.toString(),
    marketId: marketId.toString(),
    side: side.toString(),
    amount: amount.toString(),
    limitPrice: limitPrice.toString(),
    salt: salt.toString(),
    merklePath: merklePath,
    merklePathIndices: merklePathIndices,
  };

  console.log("Generating claim proof...");
  const wasmPath = path.join(__dirname, "claim/claim_js/claim.wasm");
  const zkeyPath = path.join(__dirname, "setup/claim_final.zkey");

  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const elapsed = Date.now() - startTime;

  console.log(`Proof generated in ${elapsed}ms`);
  console.log("Public signals:", publicSignals);
  console.log("  fills:", publicSignals[0]);
  console.log("  fillAmount:", publicSignals[1]);
  console.log("  refundAmount:", publicSignals[2]);
  console.log("  sideOut:", publicSignals[3]);

  // Verify
  const vkey = require("./setup/claim_vkey.json");
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("Proof valid:", valid);

  if (!valid) process.exit(1);

  // Validate outputs
  const fills = publicSignals[0];
  const fillAmount = publicSignals[1];
  const refundAmount = publicSignals[2];
  const sideOut = publicSignals[3];

  console.assert(fills === "1", "Should fill (700000 >= 650000)");
  console.assert(fillAmount === "100000000", "Fill amount should be 100000000");
  console.assert(refundAmount === "0", "No refund for filled buy");
  console.assert(sideOut === "0", "Side should be YES_BUY (0)");

  console.log("\n✓ Claim proof test passed!");
}

main().catch(e => { console.error(e); process.exit(1); });
