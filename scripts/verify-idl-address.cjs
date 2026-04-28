#!/usr/bin/env node
/**
 * Post-build IDL address sanity guard.
 *
 * Anchor 1.0's IDL emitter has a quirk (likely tied to having
 * `ika-dwallet-anchor` as a dep — its own `declare_id!` macro can leak
 * through into the predacy IDL during build). This script:
 *
 *   1. Reads each IDL in target/idl/.
 *   2. Looks up the expected address from Anchor.toml's [programs.devnet]
 *      section (also valid for [programs.localnet]).
 *   3. If the IDL's `address` field disagrees, patches it back AND
 *      re-syncs to relayer/predacy-idl.json.
 *
 * Run after every `anchor build`. Wire into the build command in CI.
 */

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const ANCHOR_TOML = path.join(REPO_ROOT, "Anchor.toml");
const TARGET_IDL_DIR = path.join(REPO_ROOT, "target", "idl");
const RELAYER_IDL = path.join(REPO_ROOT, "relayer", "predacy-idl.json");

function readExpectedAddresses() {
  const toml = fs.readFileSync(ANCHOR_TOML, "utf-8");
  const out = new Map();
  let inProgramsSection = false;
  for (const lineRaw of toml.split("\n")) {
    const line = lineRaw.trim();
    if (line.startsWith("[programs")) {
      inProgramsSection = true;
      continue;
    }
    if (line.startsWith("[") && !line.startsWith("[programs")) {
      inProgramsSection = false;
      continue;
    }
    if (!inProgramsSection || !line || line.startsWith("#")) continue;
    const m = line.match(/^([\w-]+)\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
    if (m && !out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

function patchIdl(idlPath, expected) {
  if (!fs.existsSync(idlPath)) return "missing";
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  if (idl.address === expected) return "ok";
  console.warn(
    `  [verify-idl] address drift in ${path.relative(REPO_ROOT, idlPath)}: ${idl.address} → ${expected}`,
  );
  idl.address = expected;
  fs.writeFileSync(idlPath, JSON.stringify(idl, null, 2));
  return "patched";
}

function main() {
  const expected = readExpectedAddresses();
  if (expected.size === 0) {
    console.error("[verify-idl] No [programs.*] entries found in Anchor.toml — skipping.");
    process.exit(0);
  }

  let totalPatched = 0;
  for (const [name, address] of expected) {
    const candidates = [
      path.join(TARGET_IDL_DIR, `${name}.json`),
      path.join(TARGET_IDL_DIR, `${name.replace(/-/g, "_")}.json`),
    ];
    for (const cand of candidates) {
      const result = patchIdl(cand, address);
      if (result === "patched") totalPatched++;
    }
  }

  // Re-sync the relayer's pinned IDL.
  if (fs.existsSync(RELAYER_IDL)) {
    const relayerIdl = JSON.parse(fs.readFileSync(RELAYER_IDL, "utf-8"));
    const expectedRelayer = expected.get("predacy");
    if (expectedRelayer && relayerIdl.address !== expectedRelayer) {
      relayerIdl.address = expectedRelayer;
      fs.writeFileSync(RELAYER_IDL, JSON.stringify(relayerIdl, null, 2));
      console.warn(`  [verify-idl] re-synced relayer/predacy-idl.json address → ${expectedRelayer}`);
      totalPatched++;
    }
  }

  console.log(
    `[verify-idl] ${totalPatched} file${totalPatched === 1 ? "" : "s"} patched, ${expected.size} program(s) in Anchor.toml.`,
  );
  if (totalPatched > 0) {
    console.warn("[verify-idl] Drift detected — commit the patched files.");
  }
}

main();
