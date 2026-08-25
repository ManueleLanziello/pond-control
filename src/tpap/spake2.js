import crypto from 'node:crypto';
import { p256, p384 } from '@noble/curves/nist.js';

// Adapted from ioBroker.tapo/src/lib/utils/tpapCipher.ts (MIT, TA2k).
// See THIRD_PARTY_NOTICES.md. The elliptic dependency was replaced with
// @noble/curves; this module contains only the SPAKE2+ client operations used
// by TPAP authentication and never logs secrets or derived key material.

const PAKE_CONTEXT_TAG = Buffer.from('PAKE V1');
const M_P256 = Buffer.from('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f', 'hex');
const N_P256 = Buffer.from('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49', 'hex');
const M_P384 = Buffer.from('030ff0895ae5ebf6187080a82d82b42e2765e3b2f8749c7e05eba366434b363d3dc36f15314739074d2eb8613fceec2853', 'hex');
const N_P384 = Buffer.from('02c72cf2e390853a1c1c4ad816a62fd15824f56078918f43f922ca21518f9c543bb252c5490214cf9aa3f0baab4b665c10', 'hex');

function suiteConfig(type) {
  if (!Number.isInteger(type) || type < 1 || type > 9) throw new Error(`Suite TPAP non supportata: ${type}`);
  const sha512 = [2, 4, 5, 7, 9].includes(type);
  const cmac = [8, 9].includes(type);
  const useP384 = [3, 4].includes(type);
  return {
    hash: sha512 ? 'sha512' : 'sha256',
    digestLength: sha512 ? 64 : 32,
    mac: cmac ? 'cmac' : 'hmac',
    macLength: cmac ? 16 : (sha512 ? 64 : 32),
    curve: useP384 ? p384 : p256,
    mBytes: useP384 ? M_P384 : M_P256,
    nBytes: useP384 ? N_P384 : N_P256,
  };
}

function toBigInt(bytes) {
  return BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
}

function mod(value, modulus) {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function len8le(data) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(data.length));
  return Buffer.concat([length, data]);
}

function encodeW(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length % 2 === 0) return bytes;
  return bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
}

function hkdfExpand(label, input, length, hash) {
  return Buffer.from(crypto.hkdfSync(hash, input, Buffer.alloc(length), label, length));
}

function doubleBlock(block) {
  const output = Buffer.alloc(16);
  let carry = 0;
  for (let index = 15; index >= 0; index -= 1) {
    const value = (block[index] << 1) | carry;
    output[index] = value & 0xff;
    carry = block[index] >>> 7;
  }
  if (block[0] & 0x80) output[15] ^= 0x87;
  return output;
}

function cmacAes128(key, data) {
  const aesBlock = (block) => {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(block), cipher.final()]);
  };
  const k1 = doubleBlock(aesBlock(Buffer.alloc(16)));
  const k2 = doubleBlock(k1);
  const blocks = Math.max(1, Math.ceil(data.length / 16));
  const complete = data.length > 0 && data.length % 16 === 0;
  const padded = Buffer.alloc(blocks * 16);
  data.copy(padded);
  if (!complete) padded[data.length] = 0x80;
  const subkey = complete ? k1 : k2;
  for (let index = 0; index < 16; index += 1) padded[(blocks - 1) * 16 + index] ^= subkey[index];
  let state = Buffer.alloc(16);
  for (let block = 0; block < blocks; block += 1) {
    const offset = block * 16;
    const input = Buffer.alloc(16);
    for (let index = 0; index < 16; index += 1) input[index] = state[index] ^ padded[offset + index];
    state = aesBlock(input);
  }
  return state;
}

function confirmation(mac, hash, key, point) {
  return mac === 'cmac'
    ? cmacAes128(key, point)
    : crypto.createHmac(hash, key).update(point).digest();
}

export function createSpake2Exchange({
  credential,
  devSalt,
  devShare,
  devRandom,
  userRandom,
  iterations,
  suiteType = 1,
  randomBytes = crypto.randomBytes,
}) {
  if (!credential) throw new Error('Credenziale TPAP vuota.');
  if (!Number.isSafeInteger(iterations) || iterations <= 0) throw new Error('Numero iterazioni PBKDF2 TPAP non valido.');
  const suite = suiteConfig(suiteType);
  const Point = suite.curve.Point;
  const order = Point.CURVE().n;
  const derivedLength = suite.digestLength + 8;
  const derived = crypto.pbkdf2Sync(
    Buffer.from(credential), Buffer.from(devSalt), iterations, derivedLength * 2, suite.hash,
  );
  const w0 = mod(toBigInt(derived.subarray(0, derivedLength)), order);
  const w1 = mod(toBigInt(derived.subarray(derivedLength)), order);
  if (w0 === 0n || w1 === 0n) throw new Error('Scalari SPAKE2+ non validi.');

  let x = 0n;
  while (x === 0n) x = mod(toBigInt(randomBytes(48)), order);
  const m = Point.fromBytes(suite.mBytes);
  const n = Point.fromBytes(suite.nBytes);
  const remote = Point.fromBytes(Buffer.from(devShare));
  remote.assertValidity();

  const local = Point.BASE.multiply(x).add(m.multiply(w0));
  const remotePrime = remote.subtract(n.multiply(w0));
  const z = remotePrime.multiply(x);
  const v = remotePrime.multiply(w1);
  const localBytes = Buffer.from(local.toBytes(false));
  const remoteBytes = Buffer.from(remote.toBytes(false));
  const context = crypto.createHash(suite.hash)
    .update(Buffer.concat([PAKE_CONTEXT_TAG, Buffer.from(userRandom), Buffer.from(devRandom)]))
    .digest();
  const transcript = Buffer.concat([
    len8le(context), len8le(Buffer.alloc(0)), len8le(Buffer.alloc(0)),
    len8le(Buffer.from(m.toBytes(false))), len8le(Buffer.from(n.toBytes(false))),
    len8le(localBytes), len8le(remoteBytes), len8le(Buffer.from(z.toBytes(false))),
    len8le(Buffer.from(v.toBytes(false))), len8le(encodeW(w0)),
  ]);
  const transcriptHash = crypto.createHash(suite.hash).update(transcript).digest();
  const keys = hkdfExpand('ConfirmationKeys', transcriptHash, suite.macLength * 2, suite.hash);
  const sharedKey = hkdfExpand('SharedKey', transcriptHash, suite.digestLength, suite.hash);

  return {
    userShare: localBytes,
    userConfirm: confirmation(suite.mac, suite.hash, keys.subarray(0, suite.macLength), remoteBytes),
    expectedDeviceConfirm: confirmation(suite.mac, suite.hash, keys.subarray(suite.macLength), localBytes),
    sharedKey,
    hash: suite.hash,
  };
}

export const __test = { cmacAes128, encodeW, len8le };
