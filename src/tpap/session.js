import crypto from 'node:crypto';

// Session key derivation and AEAD framing adapted from ioBroker.tapo's
// MIT-licensed tpapCipher.ts. See THIRD_PARTY_NOTICES.md.

const CIPHERS = {
  aes_128_ccm: { algorithm: 'aes-128-ccm', keyLength: 16, keyName: 'aes128' },
  aes_256_ccm: { algorithm: 'aes-256-ccm', keyLength: 32, keyName: 'aes256' },
  chacha20_poly1305: { algorithm: 'chacha20-poly1305', keyLength: 32, keyName: 'chacha20' },
};
const TAG_LENGTH = 16;

export class TpapSession {
  constructor({ sharedKey, hash, encryption, stok, startSequence }) {
    const cipher = CIPHERS[encryption];
    if (!cipher) throw new Error(`Cifratura TPAP non supportata: ${encryption}`);
    if (!stok) throw new Error('Sessione TPAP priva di identificatore.');
    if (!Number.isSafeInteger(startSequence) || startSequence < 0) throw new Error('Sequenza TPAP iniziale non valida.');
    this.cipher = cipher;
    this.hash = hash;
    this.stok = stok;
    this.sequence = startSequence;
    this.key = Buffer.from(crypto.hkdfSync(
      hash, sharedKey, `tp-kdf-salt-${cipher.keyName}-key`, `tp-kdf-info-${cipher.keyName}-key`, cipher.keyLength,
    ));
    this.baseNonce = Buffer.from(crypto.hkdfSync(
      hash, sharedKey, `tp-kdf-salt-${cipher.keyName}-iv`, `tp-kdf-info-${cipher.keyName}-iv`, 12,
    ));
  }

  get sessionPath() {
    return `/stok=${encodeURIComponent(this.stok)}/ds`;
  }

  nonce(sequence) {
    const nonce = Buffer.from(this.baseNonce);
    nonce.writeUInt32BE(sequence >>> 0, nonce.length - 4);
    return nonce;
  }

  encrypt(plaintext) {
    const sequence = this.sequence;
    const input = Buffer.from(plaintext, 'utf8');
    const options = { authTagLength: TAG_LENGTH };
    const cipher = crypto.createCipheriv(this.cipher.algorithm, this.key, this.nonce(sequence), options);
    if (this.cipher.algorithm.endsWith('-ccm')) cipher.setAAD(Buffer.alloc(0), { plaintextLength: input.length });
    const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
    const sequenceBytes = Buffer.alloc(4);
    sequenceBytes.writeUInt32BE(sequence >>> 0);
    this.sequence += 1;
    return Buffer.concat([sequenceBytes, encrypted, cipher.getAuthTag()]);
  }

  decrypt(payload) {
    const data = Buffer.from(payload);
    if (data.length < 4 + TAG_LENGTH) throw new Error('Risposta TPAP troppo corta.');
    const sequence = data.readUInt32BE(0);
    const encrypted = data.subarray(4, -TAG_LENGTH);
    const tag = data.subarray(-TAG_LENGTH);
    const options = { authTagLength: TAG_LENGTH };
    const decipher = crypto.createDecipheriv(this.cipher.algorithm, this.key, this.nonce(sequence), options);
    decipher.setAuthTag(tag);
    if (this.cipher.algorithm.endsWith('-ccm')) decipher.setAAD(Buffer.alloc(0), { plaintextLength: encrypted.length });
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  destroy() {
    this.key.fill(0);
    this.baseNonce.fill(0);
    this.stok = '';
  }
}
