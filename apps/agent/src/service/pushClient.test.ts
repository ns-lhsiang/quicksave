// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeKeyPair } from '@sumicom/quicksave-shared';
import { PushClient, httpBaseFromSignalingUrl } from './pushClient.js';

function b64urlFromB64(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function verifyCanonicalSig(
  canonical: string,
  sigB64url: string,
  pubBytes: Uint8Array,
): boolean {
  const padded = sigB64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((sigB64url.length + 3) % 4);
  const sig = new Uint8Array(Buffer.from(padded, 'base64'));
  return nacl.sign.detached.verify(new TextEncoder().encode(canonical), sig, pubBytes);
}

describe('httpBaseFromSignalingUrl', () => {
  it('wss → https', () => {
    expect(httpBaseFromSignalingUrl('wss://relay.example.com')).toBe('https://relay.example.com');
  });
  it('ws → http', () => {
    expect(httpBaseFromSignalingUrl('ws://localhost:3001')).toBe('http://localhost:3001');
  });
  it('drops trailing paths', () => {
    expect(httpBaseFromSignalingUrl('wss://relay.example.com/agent/abc')).toBe('https://relay.example.com');
  });
});

describe('PushClient', () => {
  let keyPair: nacl.SignKeyPair;
  let signPubKeyUrl: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: PushClient;

  beforeEach(() => {
    keyPair = nacl.sign.keyPair();
    signPubKeyUrl = b64urlFromB64(encodeBase64(keyPair.publicKey));
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    client = new PushClient({
      signKeyPair: encodeKeyPair({ publicKey: keyPair.publicKey, secretKey: keyPair.secretKey }),
      defaultRelayHttpUrl: 'https://relay.example',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  it('exposes the url-safe public key for addressing', () => {
    expect(client.signPubKey).toBe(signPubKeyUrl);
  });

  it('register POSTs to /push/{signPubKey}/register with a valid signature', async () => {
    const subscription = {
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p', auth: 'a' },
    };
    const result = await client.register(subscription);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://relay.example/push/${signPubKeyUrl}/register`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.endpoint).toBe(subscription.endpoint);
    expect(body.keys).toEqual(subscription.keys);
    expect(typeof body.ts).toBe('string');
    expect(typeof body.nonce).toBe('string');
    expect(typeof body.sig).toBe('string');

    const canonical = ['push:register', signPubKeyUrl, body.ts, body.nonce, subscription.endpoint].join('|');
    expect(verifyCanonicalSig(canonical, body.sig, keyPair.publicKey)).toBe(true);
  });

  it('register uses per-call relayHttpUrl override when provided', async () => {
    await client.register({ endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }, 'https://other.relay/');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://other.relay/push/${signPubKeyUrl}/register`);
  });

  it('unregister signs over the endpoint', async () => {
    const endpoint = 'https://push.example/xyz';
    await client.unregister(endpoint);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    const canonical = ['push:unregister', signPubKeyUrl, body.ts, body.nonce, endpoint].join('|');
    expect(verifyCanonicalSig(canonical, body.sig, keyPair.publicKey)).toBe(true);
  });

  it('notify signs over sessionId and forwards title/body/tag', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, sent: 2, pruned: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const res = await client.notify('session-42', { title: 'T', body: 'B', tag: 'session-42' });
    expect(res.ok).toBe(true);
    expect(res.sent).toBe(2);
    expect(res.pruned).toBe(1);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.title).toBe('T');
    expect(body.body).toBe('B');
    expect(body.tag).toBe('session-42');
    const canonical = ['push:notify', signPubKeyUrl, body.ts, body.nonce, 'session-42'].join('|');
    expect(verifyCanonicalSig(canonical, body.sig, keyPair.publicKey)).toBe(true);
  });

  it('propagates non-ok responses with parsed error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'replay' }), { status: 401 }));
    const res = await client.register({ endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error).toBe('replay');
  });

  it('returns ok=false on fetch throw', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const res = await client.register({ endpoint: 'e', keys: { p256dh: 'p', auth: 'a' } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toBe('network down');
  });

  it('produces signatures that pass the relay verifier', async () => {
    // Mirror sigVerify.ts: decode b64url → Uint8Array, reconstruct canonical, verify.
    const sub = { endpoint: 'https://push.example/verify-me', keys: { p256dh: 'p', auth: 'a' } };
    await client.register(sub);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);

    // Public key the relay would extract from the URL path — already url-safe
    // base64 in the route param. Decode same way sigVerify.ts does.
    const padded = signPubKeyUrl.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((signPubKeyUrl.length + 3) % 4);
    const pubBytes = new Uint8Array(Buffer.from(padded, 'base64'));
    expect(pubBytes).toEqual(keyPair.publicKey);

    // Reject tampered body (endpoint swap) as a sanity check
    const tamperedCanonical = ['push:register', signPubKeyUrl, body.ts, body.nonce, 'https://evil/'].join('|');
    expect(verifyCanonicalSig(tamperedCanonical, body.sig, pubBytes)).toBe(false);

    // Accept the original canonical
    const canonical = ['push:register', signPubKeyUrl, body.ts, body.nonce, sub.endpoint].join('|');
    expect(verifyCanonicalSig(canonical, body.sig, pubBytes)).toBe(true);
  });
});
