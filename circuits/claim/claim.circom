pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/mux1.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";

/*
 * Predacy Claim Proof Circuit (Poseidon version)
 *
 * Proves that a prover knows a valid order preimage included in a batch's
 * Merkle tree WITHOUT revealing which commitment is theirs.
 * Ported from Noir (~/Predacy/circuits/claim/src/main.nr).
 *
 * DEPTH = 9 (supports up to 512 orders per batch, 2^9)
 * PRICE_DECIMALS = 1_000_000
 */

template ComputeCommitment() {
    signal input marketId;
    signal input side;
    signal input amount;
    signal input limitPrice;
    signal input salt;
    signal output out;

    component hasher = Poseidon(5);
    hasher.inputs[0] <== marketId;
    hasher.inputs[1] <== side;
    hasher.inputs[2] <== amount;
    hasher.inputs[3] <== limitPrice;
    hasher.inputs[4] <== salt;
    out <== hasher.out;
}

template ComputeNullifier() {
    signal input commitment;
    signal input batchId;
    signal input salt;
    signal output out;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== commitment;
    hasher.inputs[1] <== batchId;
    hasher.inputs[2] <== salt;
    out <== hasher.out;
}

template MerkleVerify(DEPTH) {
    signal input leaf;
    signal input pathElements[DEPTH];
    signal input pathIndices[DEPTH]; // 0 = left, 1 = right
    signal output root;

    signal hashes[DEPTH + 1];
    hashes[0] <== leaf;

    component hashers[DEPTH];
    component muxLeft[DEPTH];
    component muxRight[DEPTH];

    for (var i = 0; i < DEPTH; i++) {
        // Ensure pathIndices is binary
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        // If pathIndices[i] == 0: hash(current, sibling) — current is left
        // If pathIndices[i] == 1: hash(sibling, current) — current is right
        muxLeft[i] = Mux1();
        muxLeft[i].c[0] <== hashes[i];
        muxLeft[i].c[1] <== pathElements[i];
        muxLeft[i].s <== pathIndices[i];

        muxRight[i] = Mux1();
        muxRight[i].c[0] <== pathElements[i];
        muxRight[i].c[1] <== hashes[i];
        muxRight[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxLeft[i].out;
        hashers[i].inputs[1] <== muxRight[i].out;

        hashes[i + 1] <== hashers[i].out;
    }

    root <== hashes[DEPTH];
}

template ClaimProof(DEPTH) {
    var PRICE_DECIMALS = 1000000;

    // ─── Public Inputs ───
    signal input batchId;
    signal input claimMerkleRoot;
    signal input clearingPrice;
    signal input nullifier;
    signal input recipient;      // prover-chosen payout address (no constraint)

    // ─── Public Outputs ───
    signal output fills;         // 1 if order fills, 0 if not
    signal output fillAmount;
    signal output refundAmount;
    signal output sideOut;

    // ─── Private Inputs (witness) ───
    signal input marketId;
    signal input side;           // 0=YES_BUY, 1=YES_SELL, 2=NO_BUY, 3=NO_SELL
    signal input amount;
    signal input limitPrice;
    signal input salt;
    signal input merklePath[DEPTH];
    signal input merklePathIndices[DEPTH];

    // ─── 1. Recompute commitment from order preimage ───
    component commitHasher = ComputeCommitment();
    commitHasher.marketId <== marketId;
    commitHasher.side <== side;
    commitHasher.amount <== amount;
    commitHasher.limitPrice <== limitPrice;
    commitHasher.salt <== salt;

    signal commitment;
    commitment <== commitHasher.out;

    // ─── 2. Verify Merkle membership ───
    component merkle = MerkleVerify(DEPTH);
    merkle.leaf <== commitment;
    for (var i = 0; i < DEPTH; i++) {
        merkle.pathElements[i] <== merklePath[i];
        merkle.pathIndices[i] <== merklePathIndices[i];
    }
    merkle.root === claimMerkleRoot;

    // ─── 3. Verify nullifier ───
    component nullHasher = ComputeNullifier();
    nullHasher.commitment <== commitment;
    nullHasher.batchId <== batchId;
    nullHasher.salt <== salt;
    nullHasher.out === nullifier;

    // ─── 4. Echo side ───
    sideOut <== side;

    // ─── 5. Compute fill decision ───
    signal noPrice;
    noPrice <== PRICE_DECIMALS - clearingPrice;

    // Side checks
    component isYesBuy = IsEqual();
    isYesBuy.in[0] <== side;
    isYesBuy.in[1] <== 0;

    component isYesSell = IsEqual();
    isYesSell.in[0] <== side;
    isYesSell.in[1] <== 1;

    component isNoBuy = IsEqual();
    isNoBuy.in[0] <== side;
    isNoBuy.in[1] <== 2;

    component isNoSell = IsEqual();
    isNoSell.in[0] <== side;
    isNoSell.in[1] <== 3;

    // Fill checks
    // YES_BUY fills if limitPrice >= clearingPrice
    component yesBuyFill = GreaterEqThan(64);
    yesBuyFill.in[0] <== limitPrice;
    yesBuyFill.in[1] <== clearingPrice;

    // YES_SELL fills if limitPrice <= clearingPrice
    component yesSellFill = LessEqThan(64);
    yesSellFill.in[0] <== limitPrice;
    yesSellFill.in[1] <== clearingPrice;

    // NO_BUY fills if limitPrice >= noPrice
    component noBuyFill = GreaterEqThan(64);
    noBuyFill.in[0] <== limitPrice;
    noBuyFill.in[1] <== noPrice;

    // NO_SELL fills if limitPrice <= noPrice
    component noSellFill = LessEqThan(64);
    noSellFill.in[0] <== limitPrice;
    noSellFill.in[1] <== noPrice;

    // Combined fill decision — decompose into quadratic steps
    signal yesBuyMatch;
    yesBuyMatch <== isYesBuy.out * yesBuyFill.out;
    signal yesSellMatch;
    yesSellMatch <== isYesSell.out * yesSellFill.out;
    signal noBuyMatch;
    noBuyMatch <== isNoBuy.out * noBuyFill.out;
    signal noSellMatch;
    noSellMatch <== isNoSell.out * noSellFill.out;

    signal fillDecision;
    fillDecision <== yesBuyMatch + yesSellMatch + noBuyMatch + noSellMatch;

    fills <== fillDecision;

    // ─── 6. Compute fill and refund amounts ───
    signal isSell;
    isSell <== isYesSell.out + isNoSell.out;

    // If filled: fillAmount = amount, refundAmount = 0
    // If unfilled + buy: fillAmount = 0, refundAmount = 0
    // If unfilled + sell: fillAmount = 0, refundAmount = amount
    fillAmount <== fillDecision * amount;

    // refundAmount = (1 - fillDecision) * isSell * amount
    signal unfilled;
    unfilled <== 1 - fillDecision;
    signal unfilledSell;
    unfilledSell <== unfilled * isSell;
    refundAmount <== unfilledSell * amount;
}

component main {public [
    batchId,
    claimMerkleRoot,
    clearingPrice,
    nullifier,
    recipient
]} = ClaimProof(9);
