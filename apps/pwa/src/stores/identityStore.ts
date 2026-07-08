// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';
import {
  deriveSharedKeys,
  encodeBase64,
  generateSessionDEK,
} from '@sumicom/quicksave-shared';
import {
  getMasterSecret,
  clearMasterSecret,
  importMasterSecret,
  requestPersistentStorage,
} from '../lib/secureStorage';

interface IdentityState {
  /**
   * Base64-encoded X25519 public key derived from the group's `masterSecret`.
   * Identical on every PWA that shares the secret — also used as the single
   * sync-mailbox address for the group.
   */
  publicKey: string | null;
  initialized: boolean;

  initialize: () => Promise<void>;
  getSecretKey: () => Promise<Uint8Array | null>;
  getSigningSecretKey: () => Promise<Uint8Array | null>;
  getSigningPublicKey: () => Promise<Uint8Array | null>;
  rotateIdentity: () => Promise<{
    oldPublicKey: string;
    oldSigningPublicKey: Uint8Array;
    oldSigningSecretKey: Uint8Array;
  } | null>;
  clearAll: () => Promise<void>;
}

export const useIdentityStore = create<IdentityState>((set) => ({
  publicKey: null,
  initialized: false,

  initialize: async () => {
    void requestPersistentStorage();
    const masterSecret = await getMasterSecret();
    const { x25519 } = deriveSharedKeys(masterSecret);
    set({
      publicKey: encodeBase64(x25519.publicKey),
      initialized: true,
    });
  },

  getSecretKey: async () => {
    const masterSecret = await getMasterSecret();
    return deriveSharedKeys(masterSecret).x25519.secretKey;
  },

  getSigningSecretKey: async () => {
    const masterSecret = await getMasterSecret();
    return deriveSharedKeys(masterSecret).ed25519.secretKey;
  },

  getSigningPublicKey: async () => {
    const masterSecret = await getMasterSecret();
    return deriveSharedKeys(masterSecret).ed25519.publicKey;
  },

  rotateIdentity: async () => {
    const oldSecret = await getMasterSecret();
    const oldDerived = deriveSharedKeys(oldSecret);
    const oldPublicKey = encodeBase64(oldDerived.x25519.publicKey);

    const newSecret = generateSessionDEK();
    await importMasterSecret(encodeBase64(newSecret));

    const newDerived = deriveSharedKeys(newSecret);
    set({ publicKey: encodeBase64(newDerived.x25519.publicKey) });

    return {
      oldPublicKey,
      oldSigningPublicKey: oldDerived.ed25519.publicKey,
      oldSigningSecretKey: oldDerived.ed25519.secretKey,
    };
  },

  clearAll: async () => {
    await clearMasterSecret();
    set({ publicKey: null, initialized: false });
  },
}));
