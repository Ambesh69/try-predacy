pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/poseidon.circom";
include "../../node_modules/circomlib/circuits/comparators.circom";
include "../../node_modules/circomlib/circuits/mux1.circom";

/*
 * Predacy Batch Clearing Circuit (Poseidon version)
 *
 * Proves that a clearing price correctly settles a batch of orders.
 * Ported from Noir (~/Predacy/circuits/batch_clearing/src/main.nr).
 *
 * Changes from Noir version:
 * - Poseidon hash instead of keccak256 (ZK-efficient, ~250 constraints vs ~150K)
 * - Commitment = Poseidon(marketId, side, amount, limitPrice, salt)
 * - Commitment root = sequential Poseidon chain
 * - Field elements instead of byte arrays
 *
 * MAX_ORDERS = 8 (padded with zero-amount dummy orders)
 * PRICE_DECIMALS = 1_000_000 (6-decimal fixed point)
 */

template ComputeCommitment() {
    signal input marketId;
    signal input side;
    signal input amount;
    signal input limitPrice;
    signal input salt;
    signal output out;

    // Poseidon hash of 5 inputs
    component hasher = Poseidon(5);
    hasher.inputs[0] <== marketId;
    hasher.inputs[1] <== side;
    hasher.inputs[2] <== amount;
    hasher.inputs[3] <== limitPrice;
    hasher.inputs[4] <== salt;
    out <== hasher.out;
}

template ComputeCommitmentRoot(n) {
    signal input commitments[n];
    signal input count;
    signal output out;

    // Sequential hash chain: root = Poseidon(Poseidon(...Poseidon(0, c[0]), c[1]...), c[n-1])
    // We always hash all n slots; padding commitments are 0 and still get hashed
    signal roots[n + 1];
    roots[0] <== 0;

    component hashers[n];
    for (var i = 0; i < n; i++) {
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== roots[i];
        hashers[i].inputs[1] <== commitments[i];
        roots[i + 1] <== hashers[i].out;
    }

    out <== roots[n];
}

template BatchClearing(MAX_ORDERS) {
    // ─── Public Inputs ───
    signal input commitmentRoot;
    signal input clearingPrice;
    signal input filledYesBuyVol;
    signal input filledNoBuyVol;
    signal input filledYesSellQty;
    signal input filledNoSellQty;
    signal input orderCount;

    // ─── Private Inputs (witness) ───
    signal input marketId;
    signal input sides[MAX_ORDERS];
    signal input amounts[MAX_ORDERS];
    signal input limitPrices[MAX_ORDERS];
    signal input salts[MAX_ORDERS];
    signal input commitments[MAX_ORDERS]; // on-chain stored commitment hashes

    var PRICE_DECIMALS = 1000000;

    // ─── 1. Verify clearing price validity ───
    // 0 < clearingPrice < PRICE_DECIMALS
    component priceGtZero = GreaterThan(64);
    priceGtZero.in[0] <== clearingPrice;
    priceGtZero.in[1] <== 0;
    priceGtZero.out === 1;

    component priceLtMax = LessThan(64);
    priceLtMax.in[0] <== clearingPrice;
    priceLtMax.in[1] <== PRICE_DECIMALS;
    priceLtMax.out === 1;

    signal noPrice;
    noPrice <== PRICE_DECIMALS - clearingPrice;

    // ─── 2. Verify each commitment matches its order preimage ───
    component commitHashers[MAX_ORDERS];
    for (var i = 0; i < MAX_ORDERS; i++) {
        commitHashers[i] = ComputeCommitment();
        commitHashers[i].marketId <== marketId;
        commitHashers[i].side <== sides[i];
        commitHashers[i].amount <== amounts[i];
        commitHashers[i].limitPrice <== limitPrices[i];
        commitHashers[i].salt <== salts[i];

        // Commitment must match stored hash
        commitHashers[i].out === commitments[i];
    }

    // ─── 3. Verify commitment root ───
    component rootComputer = ComputeCommitmentRoot(MAX_ORDERS);
    for (var i = 0; i < MAX_ORDERS; i++) {
        rootComputer.commitments[i] <== commitments[i];
    }
    rootComputer.count <== orderCount;
    rootComputer.out === commitmentRoot;

    // ─── 4. Compute filled volumes per side ───
    // For each order, check if it fills at the clearing price

    // Side checks: YES_BUY=0, YES_SELL=1, NO_BUY=2, NO_SELL=3
    component isYesBuy[MAX_ORDERS];
    component isYesSell[MAX_ORDERS];
    component isNoBuy[MAX_ORDERS];
    component isNoSell[MAX_ORDERS];

    // Fill checks
    component yesBuyFills[MAX_ORDERS];   // limitPrice >= clearingPrice
    component yesSellFills[MAX_ORDERS];  // limitPrice <= clearingPrice
    component noBuyFills[MAX_ORDERS];    // limitPrice >= noPrice
    component noSellFills[MAX_ORDERS];   // limitPrice <= noPrice

    // Non-zero amount check
    component amountGtZero[MAX_ORDERS];

    signal yesBuyFilled[MAX_ORDERS];
    signal yesSellFilled[MAX_ORDERS];
    signal noBuyFilled[MAX_ORDERS];
    signal noSellFilled[MAX_ORDERS];

    // Intermediate signals for quadratic constraint decomposition
    signal yesBuyFlag[MAX_ORDERS];  // isSide * fills
    signal yesSellFlag[MAX_ORDERS];
    signal noBuyFlag[MAX_ORDERS];
    signal noSellFlag[MAX_ORDERS];
    signal yesBuyActive[MAX_ORDERS]; // flag * amountGtZero
    signal yesSellActive[MAX_ORDERS];
    signal noBuyActive[MAX_ORDERS];
    signal noSellActive[MAX_ORDERS];

    // Running sums
    signal sumYesBuy[MAX_ORDERS + 1];
    signal sumNoBuy[MAX_ORDERS + 1];
    signal sumYesSell[MAX_ORDERS + 1];
    signal sumNoSell[MAX_ORDERS + 1];

    sumYesBuy[0] <== 0;
    sumNoBuy[0] <== 0;
    sumYesSell[0] <== 0;
    sumNoSell[0] <== 0;

    for (var i = 0; i < MAX_ORDERS; i++) {
        // Check side
        isYesBuy[i] = IsEqual();
        isYesBuy[i].in[0] <== sides[i];
        isYesBuy[i].in[1] <== 0;

        isYesSell[i] = IsEqual();
        isYesSell[i].in[0] <== sides[i];
        isYesSell[i].in[1] <== 1;

        isNoBuy[i] = IsEqual();
        isNoBuy[i].in[0] <== sides[i];
        isNoBuy[i].in[1] <== 2;

        isNoSell[i] = IsEqual();
        isNoSell[i].in[0] <== sides[i];
        isNoSell[i].in[1] <== 3;

        // Check amount > 0
        amountGtZero[i] = GreaterThan(64);
        amountGtZero[i].in[0] <== amounts[i];
        amountGtZero[i].in[1] <== 0;

        // YES_BUY fills if limitPrice >= clearingPrice
        yesBuyFills[i] = GreaterEqThan(64);
        yesBuyFills[i].in[0] <== limitPrices[i];
        yesBuyFills[i].in[1] <== clearingPrice;

        // YES_SELL fills if limitPrice <= clearingPrice
        yesSellFills[i] = LessEqThan(64);
        yesSellFills[i].in[0] <== limitPrices[i];
        yesSellFills[i].in[1] <== clearingPrice;

        // NO_BUY fills if limitPrice >= noPrice
        noBuyFills[i] = GreaterEqThan(64);
        noBuyFills[i].in[0] <== limitPrices[i];
        noBuyFills[i].in[1] <== noPrice;

        // NO_SELL fills if limitPrice <= noPrice
        noSellFills[i] = LessEqThan(64);
        noSellFills[i].in[0] <== limitPrices[i];
        noSellFills[i].in[1] <== noPrice;

        // Break 4-way multiplication into quadratic steps:
        // step1: flag = isSide * fills
        // step2: active = flag * amountGtZero
        // step3: filled = active * amount
        yesBuyFlag[i] <== isYesBuy[i].out * yesBuyFills[i].out;
        yesBuyActive[i] <== yesBuyFlag[i] * amountGtZero[i].out;
        yesBuyFilled[i] <== yesBuyActive[i] * amounts[i];

        yesSellFlag[i] <== isYesSell[i].out * yesSellFills[i].out;
        yesSellActive[i] <== yesSellFlag[i] * amountGtZero[i].out;
        yesSellFilled[i] <== yesSellActive[i] * amounts[i];

        noBuyFlag[i] <== isNoBuy[i].out * noBuyFills[i].out;
        noBuyActive[i] <== noBuyFlag[i] * amountGtZero[i].out;
        noBuyFilled[i] <== noBuyActive[i] * amounts[i];

        noSellFlag[i] <== isNoSell[i].out * noSellFills[i].out;
        noSellActive[i] <== noSellFlag[i] * amountGtZero[i].out;
        noSellFilled[i] <== noSellActive[i] * amounts[i];

        // Accumulate
        sumYesBuy[i + 1] <== sumYesBuy[i] + yesBuyFilled[i];
        sumNoBuy[i + 1] <== sumNoBuy[i] + noBuyFilled[i];
        sumYesSell[i + 1] <== sumYesSell[i] + yesSellFilled[i];
        sumNoSell[i + 1] <== sumNoSell[i] + noSellFilled[i];
    }

    // ─── 5. Verify filled volumes match public inputs ───
    sumYesBuy[MAX_ORDERS] === filledYesBuyVol;
    sumNoBuy[MAX_ORDERS] === filledNoBuyVol;
    sumYesSell[MAX_ORDERS] === filledYesSellQty;
    sumNoSell[MAX_ORDERS] === filledNoSellQty;
}

component main {public [
    commitmentRoot,
    clearingPrice,
    filledYesBuyVol,
    filledNoBuyVol,
    filledYesSellQty,
    filledNoSellQty,
    orderCount
]} = BatchClearing(8);
