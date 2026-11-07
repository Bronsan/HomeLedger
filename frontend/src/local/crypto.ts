/**
 * End-to-end encryption for synced data.
 *
 * Design constraints, in order:
 *
 * 1. The server must not be able to read private fields. Not "we promise not
 *    to look" — mathematically unable.
 * 2. A new device must be able to join with just the family passphrase. No
 *    key escrow, no per-device approval dance that silently fails when the
 *    other phone is flat.
 * 3. It has to run in a WebView on a five-year-old phone. That rules out
 *    WebCrypto's AES-GCM (unavailable outside secure contexts, and Tauri's
 *    custom scheme is not one on every platform) and rules out shipping a
 *    WASM crypto module (bundle size, startup cost).
 *
 * So: pure-JS XChaCha20-Poly1305 from @noble/ciphers, Argon2id from
 * @noble/hashes. Both are audited, dependency-free, and run everywhere a
 * `Uint8Array` exists.
 *
 * Key hierarchy
 *
 *   passphrase --Argon2id(salt)--> KEK --XChaCha20--> DEK (32 random bytes)
 *   DEK --XChaCha20--> field ciphertext / attachment chunks
 *
 * The server stores the salt plus the wrapped DEK. Changing the passphrase
 * re-wraps the DEK and leaves every existing ciphertext readable — which is
 * exactly what "change password" should mean.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { sha256 } from "@noble/hashes/sha2.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const KEY_VERSION = "hl1";

export interface KdfParams {
  memory_kib: number;
  iterations: number;
  parallelism: number;
}

/** 64 MiB / 3 passes remains the default. The supported floor is 19 MiB /
 * 2 passes; untrusted bundles cannot request more than 128 MiB, 6 passes,
 * 4 lanes, or 384 MiB-passes of work. These are protocol/application limits,
 * not a request to silently retune Argon2 on a low-memory device. */
export const DEFAULT_KDF: Readonly<KdfParams> = Object.freeze({
  memory_kib: 65536,
  iterations: 3,
  parallelism: 1,
});
const MAX_KDF_MEMORY_KIB = 131072;
const MAX_KDF_WORK = 393216;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const SEALED_OVERHEAD = NONCE_BYTES + TAG_BYTES;

export interface KeyBundle {
  kdf: "argon2id";
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
  wrapped_dek: string;
  verifier: string;
}

// --- encoding helpers -------------------------------------------------------
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function aadBytes(aad: string): Uint8Array {
  return encoder.encode(aad);
}

// --- symmetric primitives ---------------------------------------------------
export function encryptJson(dek: Uint8Array, value: unknown, aad: string): string {
  return encryptText(dek, JSON.stringify(value), aad);
}

export function decryptJson<T>(dek: Uint8Array, payload: string, aad: string): T {
  return JSON.parse(decryptText(dek, payload, aad)) as T;
}

export function encryptText(dek: Uint8Array, text: string, aad: string): string {
  return toBase64(encryptBytes(dek, encoder.encode(text), aad));
}

export function decryptText(dek: Uint8Array, payload: string, aad: string): string {
  return decoder.decode(decryptBytes(dek, fromBase64(payload), aad));
}

function validateKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error("密钥长度必须为 32 字节");
  }
}

export function encryptBytes(dek: Uint8Array, plain: Uint8Array, aad: string): Uint8Array {
  validateKey(dek);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = xchacha20poly1305(dek, nonce, aadBytes(aad));
  const body = cipher.encrypt(plain);
  const out = new Uint8Array(nonce.length + body.length);
  out.set(nonce, 0);
  out.set(body, nonce.length);
  return out;
}

export function decryptBytes(dek: Uint8Array, payload: Uint8Array, aad: string): Uint8Array {
  validateKey(dek);
  if (payload.length < SEALED_OVERHEAD) throw new Error("密文长度不正确");
  const nonce = payload.subarray(0, NONCE_BYTES);
  const body = payload.subarray(NONCE_BYTES);
  const cipher = xchacha20poly1305(dek, nonce, aadBytes(aad));
  return cipher.decrypt(body);
}

// --- key derivation ---------------------------------------------------------
function validateKdfParams(value: unknown): KdfParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Argon2id 参数格式不正确");
  }
  const { memory_kib, iterations, parallelism } = value as Partial<KdfParams>;
  if (typeof memory_kib !== "number" || !Number.isSafeInteger(memory_kib) ||
      memory_kib < 19456 || memory_kib > MAX_KDF_MEMORY_KIB) {
    throw new Error("Argon2id memory_kib 必须为 19456–131072 的整数（19–128 MiB）");
  }
  if (typeof iterations !== "number" || !Number.isSafeInteger(iterations) ||
      iterations < 2 || iterations > 6) {
    throw new Error("Argon2id iterations 必须为 2–6 的整数");
  }
  if (typeof parallelism !== "number" || !Number.isSafeInteger(parallelism) ||
      parallelism < 1 || parallelism > 4) {
    throw new Error("Argon2id parallelism 必须为 1–4 的整数");
  }
  if (memory_kib * iterations > MAX_KDF_WORK) {
    throw new Error("Argon2id 参数超过资源预算（最多 384 MiB-passes）");
  }
  // Copy the declaration: callers must not change what is persisted while the
  // asynchronous KDF is running. Noble performs Argon2's specified lane rounding.
  return { memory_kib, iterations, parallelism };
}

export async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams
): Promise<Uint8Array> {
  const checked = validateKdfParams(params);
  if (typeof passphrase !== "string") throw new Error("同步口令必须为字符串");
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) {
    throw new Error("Argon2id salt 长度必须为 16 字节");
  }
  const password = encoder.encode(passphrase);
  try {
    return await argon2idAsync(password, salt.slice(), {
      t: checked.iterations,
      m: checked.memory_kib,
      p: checked.parallelism,
      version: 0x13,
      dkLen: KEY_BYTES,
      maxmem: MAX_KDF_MEMORY_KIB * 1024,
    });
  } catch (err) {
    // Never retry with different parameters, including bundles affected by the
    // former memory-halving bug. Guessing would hide corrupt metadata again.
    const detail = err instanceof Error ? err.message : "未知错误";
    throw new Error(`Argon2id 密钥派生失败（未更改参数）：${detail}`);
  } finally {
    password.fill(0);
  }
}

const VERIFIER_TEXT = `${KEY_VERSION}|verify`;

function bundleBytes(value: unknown, size: number, name: string): Uint8Array {
  if (typeof value !== "string" || value.length !== 4 * Math.ceil(size / 3)) {
    throw new Error(`密钥材料 ${name} 格式或长度不正确`);
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(value);
  } catch {
    throw new Error(`密钥材料 ${name} 不是有效的 Base64`);
  }
  if (bytes.length !== size || toBase64(bytes) !== value) {
    throw new Error(`密钥材料 ${name} 格式或长度不正确`);
  }
  return bytes;
}

function validateBundle(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("密钥材料格式不正确");
  }
  const bundle = value as Partial<KeyBundle>;
  if (bundle.kdf !== "argon2id") throw new Error("不支持的密钥派生算法（kdf）");
  return {
    params: validateKdfParams(bundle),
    salt: bundleBytes(bundle.salt, SALT_BYTES, "salt"),
    wrapped: bundleBytes(bundle.wrapped_dek, KEY_BYTES + SEALED_OVERHEAD, "wrapped_dek"),
    verifier: bundleBytes(bundle.verifier, encoder.encode(VERIFIER_TEXT).length + SEALED_OVERHEAD, "verifier"),
  };
}

export interface CreatedBundle {
  bundle: KeyBundle;
  dek: Uint8Array;
}

/** First device: mint a random DEK and wrap it with the declared parameters. */
export async function createKeyBundle(
  passphrase: string,
  params: KdfParams = DEFAULT_KDF
): Promise<CreatedBundle> {
  const checked = validateKdfParams(params);
  const dek = randomBytes(KEY_BYTES);
  try {
    return { dek, bundle: await rewrapKeyBundle(dek, passphrase, checked) };
  } catch (err) {
    dek.fill(0);
    throw err;
  }
}

/** Any later device: validate the complete bundle before spending KDF resources. */
export async function unlockKeyBundle(bundle: KeyBundle, passphrase: string): Promise<Uint8Array> {
  const checked = validateBundle(bundle);
  const kek = await deriveKek(passphrase, checked.salt, checked.params);
  let dek: Uint8Array;
  try {
    dek = decryptBytes(kek, checked.wrapped, `${KEY_VERSION}|wrap`);
  } catch {
    throw new Error("同步口令不正确或密钥材料损坏；仅使用声明的 Argon2id 参数，请确认原始设备或备份");
  } finally {
    kek.fill(0);
  }
  try {
    validateKey(dek);
    const proof = decoder.decode(decryptBytes(dek, checked.verifier, `${KEY_VERSION}|verifier`));
    if (proof !== VERIFIER_TEXT) throw new Error("verifier mismatch");
    return dek;
  } catch {
    dek.fill(0);
    throw new Error("密钥材料 verifier 损坏，请重新配对");
  }
}

/** Re-wrap the same 32-byte DEK; existing hl1 field ciphertext stays readable. */
export async function rewrapKeyBundle(
  dek: Uint8Array,
  passphrase: string,
  params: KdfParams = DEFAULT_KDF
): Promise<KeyBundle> {
  validateKey(dek);
  const checked = validateKdfParams(params);
  const key = dek.slice();
  const salt = randomBytes(SALT_BYTES);
  let kek: Uint8Array | undefined;
  try {
    kek = await deriveKek(passphrase, salt, checked);
    return {
      kdf: "argon2id",
      salt: toBase64(salt),
      ...checked,
      wrapped_dek: toBase64(encryptBytes(kek, key, `${KEY_VERSION}|wrap`)),
      verifier: encryptText(key, VERIFIER_TEXT, `${KEY_VERSION}|verifier`),
    };
  } finally {
    kek?.fill(0);
    key.fill(0);
  }
}

// --- attachment framing -----------------------------------------------------
/**
 * HLB2 (all integers big-endian):
 *   header: "HLB2" | chunkSize:u32 | randomFileId:16 | totalPlainBytes:u64 | count:u32
 *   count records: sealedLength:u32 | nonce:24 | XChaCha20-Poly1305 ciphertext+tag
 *   trailer: "END2" | nonce:24 | Poly1305 tag (AEAD of empty plaintext)
 *
 * Every record authenticates the entire header and its index. The separately
 * authenticated trailer has its own domain and the final count. Exact lengths,
 * canonical chunk sizes, and a required trailer reject truncation at boundaries,
 * reorder, splices between files encrypted under the same DEK, and trailing data.
 * Empty files have one authenticated empty record AND the authenticated trailer.
 * This is framing around noble's AEAD, not a new encryption primitive.
 *
 * HLB1 remains READ-ONLY compatible below. It has no authenticated file identity,
 * total length, count or ending: valid per-chunk tags cannot prove whole-file
 * integrity, detect a complete final-chunk deletion or a same-index cross-file
 * splice. Do not treat decryption/re-encryption of legacy data as proof that the
 * original file was complete. No automatic re-enveloping/migration happens here.
 */
const MAGIC_V1 = encoder.encode("HLB1");
const MAGIC_V2 = encoder.encode("HLB2");
const END_V2 = encoder.encode("END2");
const HEADER_V2_BYTES = 36;
const TRAILER_V2_BYTES = END_V2.length + SEALED_OVERHEAD;
export const CHUNK_SIZE = 1024 * 1024;

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function hasMagic(bytes: Uint8Array, magic: Uint8Array): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

function blobAad(header: Uint8Array): string {
  // Canonical fixed-length encoding binds every header byte, including the id.
  return `${KEY_VERSION}|blob|HLB2|${toBase64(header)}`;
}

function openBlobPart(dek: Uint8Array, payload: Uint8Array, aad: string): Uint8Array {
  try {
    return decryptBytes(dek, payload, aad);
  } catch {
    throw new Error("附件密文认证失败（密钥不正确或附件被篡改）");
  }
}

export function encryptBlob(dek: Uint8Array, plain: Uint8Array): Uint8Array {
  validateKey(dek);
  const count = Math.max(1, Math.ceil(plain.length / CHUNK_SIZE));
  const header = new Uint8Array(HEADER_V2_BYTES);
  header.set(MAGIC_V2);
  header.set(randomBytes(16), 8);
  const view = new DataView(header.buffer);
  view.setUint32(4, CHUNK_SIZE, false);
  // Use two u32 words rather than BigInt so this also works on older WebViews.
  view.setUint32(24, Math.floor(plain.length / 0x100000000), false);
  view.setUint32(28, plain.length % 0x100000000, false);
  view.setUint32(32, count, false);
  const aad = blobAad(header);
  const parts: Uint8Array[] = [header];
  for (let index = 0; index < count; index++) {
    const slice = plain.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
    const sealed = encryptBytes(dek, slice, `${aad}|chunk|${index}`);
    parts.push(uint32(sealed.length), sealed);
  }
  parts.push(END_V2, encryptBytes(dek, new Uint8Array(0), `${aad}|end|${count}`));
  return concat(parts);
}

function decryptBlobV2(dek: Uint8Array, framed: Uint8Array): Uint8Array {
  if (framed.length < HEADER_V2_BYTES + 4 + SEALED_OVERHEAD + TRAILER_V2_BYTES) {
    throw new Error("附件密文被截断（HLB2）");
  }
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  if (view.getUint32(4, false) !== CHUNK_SIZE) throw new Error("不支持的附件分块大小（HLB2）");
  const total = view.getUint32(24, false) * 0x100000000 + view.getUint32(28, false);
  const count = view.getUint32(32, false);
  if (!Number.isSafeInteger(total) || count !== Math.max(1, Math.ceil(total / CHUNK_SIZE))) {
    throw new Error("附件总长或块数不正确（HLB2）");
  }
  const expectedLength = HEADER_V2_BYTES + total + count * (4 + SEALED_OVERHEAD) + TRAILER_V2_BYTES;
  if (!Number.isSafeInteger(expectedLength) || framed.length !== expectedLength) {
    throw new Error("附件密文长度不正确、被截断或含尾随数据（HLB2）");
  }
  const aad = blobAad(framed.subarray(0, HEADER_V2_BYTES));
  const trailerOffset = framed.length - TRAILER_V2_BYTES;
  if (!hasMagic(framed.subarray(trailerOffset), END_V2)) {
    throw new Error("附件密文缺少结尾标记（HLB2）");
  }
  // Check the authenticated manifest/end before allocating the plaintext buffer.
  openBlobPart(dek, framed.subarray(trailerOffset + END_V2.length), `${aad}|end|${count}`);
  const plain = new Uint8Array(total);
  let offset = HEADER_V2_BYTES;
  let written = 0;
  for (let index = 0; index < count; index++) {
    const size = Math.min(CHUNK_SIZE, total - written);
    const sealedLength = size + SEALED_OVERHEAD;
    if (view.getUint32(offset, false) !== sealedLength) {
      throw new Error("附件分块长度不正确（HLB2）");
    }
    offset += 4;
    const chunk = openBlobPart(dek, framed.subarray(offset, offset + sealedLength), `${aad}|chunk|${index}`);
    plain.set(chunk, written);
    written += chunk.length;
    offset += sealedLength;
  }
  return plain;
}

function decryptBlobV1(dek: Uint8Array, framed: Uint8Array): Uint8Array {
  if (framed.length < 8 + 4 + SEALED_OVERHEAD) throw new Error("附件密文被截断（HLB1）");
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  // Historical writers always emitted this exact size. The HLB1 header is not
  // authenticated; do not let it control allocations or weaken record checks.
  if (view.getUint32(4, false) !== CHUNK_SIZE) throw new Error("不支持的附件分块大小（HLB1）");
  let offset = 8;
  const chunks: Uint8Array[] = [];
  let index = 0;
  while (offset < framed.length) {
    if (offset + 4 > framed.length) throw new Error("附件密文被截断（HLB1）");
    const len = view.getUint32(offset, false);
    offset += 4;
    if (len < SEALED_OVERHEAD || len > CHUNK_SIZE + SEALED_OVERHEAD) {
      throw new Error("附件分块长度不正确（HLB1）");
    }
    if (offset + len > framed.length) throw new Error("附件密文被截断（HLB1）");
    // Only a final record may be short, and only a sole record may be empty.
    if ((offset + len < framed.length && len !== CHUNK_SIZE + SEALED_OVERHEAD) ||
        (index > 0 && len === SEALED_OVERHEAD)) {
      throw new Error("附件分块格式不正确（HLB1）");
    }
    chunks.push(openBlobPart(dek, framed.subarray(offset, offset + len), `${KEY_VERSION}|blob|${index}`));
    offset += len;
    index++;
  }
  return concat(chunks);
}

export function decryptBlob(dek: Uint8Array, framed: Uint8Array): Uint8Array {
  validateKey(dek);
  if (hasMagic(framed, MAGIC_V2)) return decryptBlobV2(dek, framed);
  if (hasMagic(framed, MAGIC_V1)) return decryptBlobV1(dek, framed);
  throw new Error("附件密文格式不正确或版本不支持");
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
