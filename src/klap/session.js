import crypto from 'node:crypto';

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function signedSequenceBuffer(sequence) {
  const result = Buffer.allocUnsafe(4);
  result.writeInt32BE(sequence);
  return result;
}

export function deriveKlapV2AuthHash(username, password) {
  const normalizedUsername = String(username).normalize('NFKC');
  const normalizedPassword = String(password).normalize('NFKC');
  const usernameHash = crypto.createHash('sha1').update(normalizedUsername, 'utf8').digest();
  const passwordHash = crypto.createHash('sha1').update(normalizedPassword, 'utf8').digest();
  return sha256(usernameHash, passwordHash);
}

export function klapV2Handshake1Challenge(localSeed, remoteSeed, authHash) {
  return sha256(localSeed, remoteSeed, authHash);
}

export function klapV2Handshake2Challenge(localSeed, remoteSeed, authHash) {
  return sha256(remoteSeed, localSeed, authHash);
}

// KLAP v2 derivation and framing are adapted from the MIT-licensed
// ioBroker.tapo newTpLinkCipher/P100 implementation. See THIRD_PARTY_NOTICES.md.
export class KlapV2Session {
  constructor(localSeed, remoteSeed, authHash) {
    this.key = sha256(Buffer.from('lsk'), localSeed, remoteSeed, authHash).subarray(0, 16);
    const fullIv = sha256(Buffer.from('iv'), localSeed, remoteSeed, authHash);
    this.ivPrefix = fullIv.subarray(0, 12);
    this.sequence = fullIv.readInt32BE(28);
    this.signatureKey = sha256(Buffer.from('ldk'), localSeed, remoteSeed, authHash).subarray(0, 28);
  }

  encrypt(plaintext) {
    this.sequence = (this.sequence + 1) | 0;
    const sequenceBytes = signedSequenceBuffer(this.sequence);
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, Buffer.concat([this.ivPrefix, sequenceBytes]));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const signature = sha256(this.signatureKey, sequenceBytes, ciphertext);
    return { payload: Buffer.concat([signature, ciphertext]), sequence: this.sequence };
  }

  decrypt(payload, sequence = this.sequence) {
    if (!Buffer.isBuffer(payload) || payload.length < 48 || (payload.length - 32) % 16 !== 0) {
      throw new Error('Risposta KLAP cifrata con lunghezza non valida.');
    }
    const sequenceBytes = signedSequenceBuffer(sequence);
    const signature = payload.subarray(0, 32);
    const ciphertext = payload.subarray(32);
    const expected = sha256(this.signatureKey, sequenceBytes, ciphertext);
    if (!crypto.timingSafeEqual(signature, expected)) throw new Error('Firma della risposta KLAP non valida.');
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, Buffer.concat([this.ivPrefix, sequenceBytes]));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  destroy() {
    this.key.fill(0);
    this.ivPrefix.fill(0);
    this.signatureKey.fill(0);
  }
}

export const __test = { signedSequenceBuffer };
