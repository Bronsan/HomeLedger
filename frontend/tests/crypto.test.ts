/**
 * Crypto protocol tests.
 *
 * The interesting cases are the negative ones: a bundle that claims impossible
 * KDF parameters, a ciphertext from another record, a truncated attachment, or
 * a single flipped bit. All of them must fail closed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHUNK_SIZE,
  createKeyBundle,
  decryptBlob,
  decryptText,
  encryptBlob,
  encryptText,
  fromBase64,
  rewrapKeyBundle,
  sha256Hex,
  toBase64,
  unlockKeyBundle,
} from "../src/local/crypto";

const PASS = "correct horse battery staple";
// The protocol floor: fast enough for tests, still a real Argon2id derivation.
const FAST_KDF = { memory_kib: 19456, iterations: 2, parallelism: 1 } as const;
const KEY = new Uint8Array(32).fill(7);

function same(a: Uint8Array, b: Uint8Array): void {
  assert.equal(a.length, b.length);
  assert.deepEqual(Array.from(a), Array.from(b));
}

test("base64 round-trips every byte value", () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  same(fromBase64(toBase64(bytes)), bytes);
  assert.equal(toBase64(new Uint8Array(0)), "");
  same(fromBase64(""), new Uint8Array(0));
});

test("sha256 matches a known vector", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("key bundle wraps the same DEK across passphrase rotation", async () => {
  const { bundle, dek } = await createKeyBundle(PASS, FAST_KDF);
  assert.equal(bundle.kdf, "argon2id");
  assert.equal(bundle.memory_kib, FAST_KDF.memory_kib);

  same(await unlockKeyBundle(bundle, PASS), dek);

  const rotated = await rewrapKeyBundle(dek, "a new passphrase", FAST_KDF);
  same(await unlockKeyBundle(rotated, "a new passphrase"), dek);
  await assert.rejects(() => unlockKeyBundle(rotated, PASS), /同步口令不正确/);
});

test("wrong passphrase never yields a key", async () => {
  const { bundle } = await createKeyBundle(PASS, FAST_KDF);
  await assert.rejects(() => unlockKeyBundle(bundle, "not the passphrase"), /同步口令不正确/);
});

test("a bundle with impossible KDF parameters is rejected before deriving", async () => {
  await assert.rejects(
    () => createKeyBundle(PASS, { memory_kib: 1024, iterations: 2, parallelism: 1 }),
    /memory_kib/,
  );
  await assert.rejects(
    () => createKeyBundle(PASS, { memory_kib: 131072, iterations: 6, parallelism: 1 }),
    /资源预算/,
  );
  await assert.rejects(
    () => createKeyBundle(PASS, { memory_kib: 19456, iterations: 1, parallelism: 1 }),
    /iterations/,
  );
});

test("tampered key material fails closed", async () => {
  const { bundle } = await createKeyBundle(PASS, FAST_KDF);

  const salt = fromBase64(bundle.salt);
  salt[0] ^= 1;
  await assert.rejects(() => unlockKeyBundle({ ...bundle, salt: toBase64(salt) }, PASS));

  const wrapped = fromBase64(bundle.wrapped_dek);
  wrapped[wrapped.length - 1] ^= 1;
  await assert.rejects(
    () => unlockKeyBundle({ ...bundle, wrapped_dek: toBase64(wrapped) }, PASS),
    /同步口令不正确/,
  );

  const verifier = fromBase64(bundle.verifier);
  verifier[0] ^= 1;
  await assert.rejects(
    () => unlockKeyBundle({ ...bundle, verifier: toBase64(verifier) }, PASS),
    /verifier/,
  );
});

test("fields are bound to their AAD and reject modification", () => {
  const sealed = encryptText(KEY, "序列号 SN-123", "hl1|item|i1");
  assert.equal(decryptText(KEY, sealed, "hl1|item|i1"), "序列号 SN-123");
  assert.throws(() => decryptText(KEY, sealed, "hl1|item|i2"));

  const bytes = fromBase64(sealed);
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() => decryptText(KEY, toBase64(bytes), "hl1|item|i1"));

  const otherKey = new Uint8Array(32).fill(8);
  assert.throws(() => decryptText(otherKey, sealed, "hl1|item|i1"));
});

test("attachment framing round-trips exact chunk boundaries", () => {
  const sizes = [0, 1, 31, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, CHUNK_SIZE * 2 + 7];
  for (const size of sizes) {
    const plain = new Uint8Array(size);
    for (let i = 0; i < size; i++) plain[i] = (i * 31 + 7) & 0xff;
    const framed = encryptBlob(KEY, plain);
    same(decryptBlob(KEY, framed), plain);
  }
});

test("attachment truncation, extension, reordering and header edits are rejected", () => {
  const plain = new Uint8Array(CHUNK_SIZE * 2 + 11).fill(9);
  const framed = encryptBlob(KEY, plain);

  assert.throws(() => decryptBlob(KEY, framed.subarray(0, framed.length - 1)));
  const extended = new Uint8Array(framed.length + 1);
  extended.set(framed);
  assert.throws(() => decryptBlob(KEY, extended));

  // Header length is authenticated: claiming a different total size must fail
  // even when the trailer and every chunk are intact.
  const headerEdit = framed.slice();
  new DataView(headerEdit.buffer).setUint32(28, plain.length + 1, false);
  assert.throws(() => decryptBlob(KEY, headerEdit));

  const bodyEdit = framed.slice();
  bodyEdit[Math.floor(bodyEdit.length / 2)] ^= 1;
  assert.throws(() => decryptBlob(KEY, bodyEdit));

  assert.throws(() => decryptBlob(new Uint8Array(32).fill(3), framed));
});
