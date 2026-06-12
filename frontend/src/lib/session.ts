"use client";

// Per-wallet local "session key" — a keypair kept in localStorage that signs ER trades so the
// browser wallet (Phantom) never has to sign an ephemeral-rollup transaction (which it can't
// simulate against devnet and would warn/block on). The owner authorizes it once on L1 via the
// program's `set_session_key`, after which open/close/etc. are signed by this key with no popups.
// This is the canonical MagicBlock browser pattern (cf. roll-dice/app, session-keys/app).
import { Keypair, PublicKey } from "@solana/web3.js";

const storageKey = (owner: string) => `shear:sessionkey:${owner}`;

// Get (or create + persist) the session keypair for a given owner wallet.
export function getSessionKeypair(owner: PublicKey): Keypair {
  const k = storageKey(owner.toBase58());
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(k);
    if (stored) {
      try {
        return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
      } catch {
        /* corrupt entry — regenerate below */
      }
    }
  }
  const kp = Keypair.generate();
  if (typeof window !== "undefined") {
    window.localStorage.setItem(k, JSON.stringify(Array.from(kp.secretKey)));
  }
  return kp;
}

export function sessionKeyPubkey(owner: PublicKey): PublicKey {
  return getSessionKeypair(owner).publicKey;
}
