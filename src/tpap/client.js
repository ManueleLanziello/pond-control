import crypto from 'node:crypto';
import { createSpake2Exchange } from './spake2.js';
import { TpapSession } from './session.js';
import { createTpapHttpAgent, postTpapBuffer, postTpapJson } from './http.js';

// The currently verified TPAP plug path in ioBroker.tapo offers this minimal
// pair during pake_register. Additional suites/ciphers remain implemented in
// the crypto modules, but advertising them here changes the wire request.
const REGISTER_CIPHER_SUITES = [1];
const REGISTER_ENCRYPTIONS = ['aes_128_ccm'];

function headerValue(response, name) {
  return response.headers.get(name) || 'non dichiarato';
}

function summarizeSafeHtml(bytes) {
  const text = Buffer.from(bytes).toString('utf8').toLowerCase();
  if (/\b404\b|not found/.test(text)) return 'pagina generica 404/non trovata';
  if (/\b403\b|forbidden|access denied/.test(text)) return 'pagina generica 403/accesso negato';
  if (/redirect|moved permanently|moved temporarily/.test(text)) return 'pagina generica di redirect';
  if (/method not (?:allowed|supported)|unsupported method/.test(text)) return 'metodo non supportato';
  if (/<html|<!doctype/.test(text)) return 'pagina HTML generica/placeholder';
  return 'testo HTML non classificato';
}

export function classifyHttpBody(bytes, contentType = '') {
  const data = Buffer.from(bytes);
  const hasUtf8Bom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  const compression = data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b
    ? 'gzip'
    : data.length >= 2 && data[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(data[1])
      ? 'zlib/deflate'
      : null;
  if (!data.length) return { format: 'vuoto', text: '' };
  if (compression) return { format: `binario compresso (${compression})`, text: null };

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return { format: 'binario/non UTF-8', text: null };
  }
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const trimmed = withoutBom.trim();
  const controlBytes = [...trimmed].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 && !['\r', '\n', '\t'].includes(character);
  });
  if (controlBytes) return { format: 'testo UTF-8 con byte di controllo', text: null };
  if (/^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(trimmed)) return { format: 'HTML', text: null };
  try {
    JSON.parse(trimmed);
    const detail = hasUtf8Bom ? 'JSON UTF-8 con BOM' : 'JSON UTF-8';
    return { format: detail, text: trimmed };
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        return { format: 'JSON con prefisso/suffisso non JSON', text: null };
      } catch { /* classificato sotto come testo */ }
    }
  }
  const claimedJson = /(?:application|text)\/(?:[\w.+-]*\+)?json/i.test(contentType);
  return { format: claimedJson ? 'testo UTF-8 nonostante Content-Type JSON' : 'testo UTF-8 non JSON', text: null };
}

async function readJson(response, operation) {
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = headerValue(response, 'content-type');
  const classified = classifyHttpBody(bytes, contentType);
  const diagnostics = [
    `HTTP status=${response.status}`,
    `Content-Type=${contentType}`,
    `Content-Length=${headerValue(response, 'content-length')}`,
    `Content-Encoding=${headerValue(response, 'content-encoding')}`,
    `body bytes=${bytes.length}`,
    `formato=${classified.format}`,
    `redirect=${response.redirected ? 'SI' : 'NO'}`,
  ].join(', ');
  if (!response.ok) throw new Error(`${operation}: ${diagnostics}`);
  if (classified.text === null) {
    const error = new Error(`${operation}: risposta JSON non valida; ${diagnostics}`);
    error.tpapHttpResponse = {
      status: response.status,
      format: classified.format,
      bodySha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      safeSummary: classified.format === 'HTML' ? summarizeSafeHtml(bytes) : classified.format,
    };
    throw error;
  }
  let body;
  try { body = JSON.parse(classified.text); } catch { throw new Error(`${operation}: risposta JSON non valida; ${diagnostics}`); }
  if (body.error_code !== 0) throw new Error(`${operation}: error_code=${body.error_code}`);
  return body.result || {};
}

function authUsername(pake, userHashType) {
  // This standalone client targets non-camera Tapo plugs: TPAP uses "admin".
  const digest = crypto.createHash(userHashType === 1 ? 'sha256' : 'md5').update('admin').digest('hex');
  return userHashType === 1 ? digest.toUpperCase() : digest;
}

function passcodeType(pake) {
  if (pake.includes(0)) return 'default_userpw';
  if (pake.some((value) => [1, 2, 5].includes(value))) return 'userpw';
  if (pake.includes(3)) return 'shared_token';
  return 'default_userpw';
}

function candidateSecrets(password, pake) {
  if (!pake.length || pake.includes(0)) return [password];
  if (pake.includes(2)) {
    return [...new Set([
      password,
      crypto.createHash('md5').update(password).digest('hex'),
      crypto.createHash('sha256').update(password).digest('hex').toUpperCase(),
    ])];
  }
  return [password];
}

function resolveCredential(secret, username, extraCrypt) {
  if (!extraCrypt) return secret;
  const type = String(extraCrypt.type || '').toLowerCase();
  const params = extraCrypt.params || {};
  if (type === 'password_shadow' && Number(params.passwd_id) === 2) {
    return crypto.createHash('sha1').update(secret).digest('hex');
  }
  if (type === 'password_shadow' && Number(params.passwd_id) === 3) {
    throw new Error('TPAP password_shadow passwd_id=3 richiede il MAC: variante non ancora abilitata.');
  }
  if (type === 'password_sha_with_salt') {
    const name = Number(params.sha_name) === 0 ? 'admin' : 'user';
    const salt = params.sha_salt ? Buffer.from(params.sha_salt, 'base64') : Buffer.alloc(0);
    return crypto.createHash('sha256').update(name).update(salt).update(secret).digest('hex');
  }
  if (type) throw new Error(`Variante extra_crypt TPAP non supportata in sicurezza: ${type}`);
  return username ? `${username}/${secret}` : secret;
}

export class TpapClient {
  constructor({ ip, username, password, port = 80, timeout = 5000, jsonTransport = postTpapJson }) {
    this.ip = ip;
    this.username = username;
    this.password = password;
    this.port = port;
    this.timeout = timeout;
    this.baseUrl = port === 80 ? `http://${ip}` : `http://${ip}:${port}`;
    this.session = null;
    this.protocol = null;
    this.jsonTransport = jsonTransport;
    this.httpAgent = createTpapHttpAgent();
    this.discoverHttpResponse = null;
  }

  async postJson(payload, operation) {
    const response = await this.jsonTransport(this.baseUrl, payload, {
      timeout: this.timeout,
      agent: this.httpAgent,
    });
    return readJson(response, operation);
  }

  async discoverProtocol() {
    console.log(`TPAP discover request: POST ${this.baseUrl}/`);
    console.log('  Content-Type: application/json; charset=UTF-8');
    console.log('  JSON: method=login, params.sub_method=discover (nessun segreto nel payload)');
    let result;
    try {
      result = await this.postJson({ method: 'login', params: { sub_method: 'discover' } }, 'TPAP discover');
    } catch (error) {
      if (error.tpapHttpResponse?.status === 200) {
        this.discoverHttpResponse = error.tpapHttpResponse;
        console.log(`TPAP discover: FALLITA (${error.tpapHttpResponse.format})`);
        this.protocol = { pake: [2], userHashType: 0, port: this.port, tls: false, fallback: true };
        console.log('TPAP discover fallback pake:[2]: OK');
        return { ...this.protocol };
      }
      console.log(`TPAP discover: FALLITA (${error.message})`);
      throw error;
    }
    const tpap = result.tpap || result;
    if (!Array.isArray(tpap.pake) || !tpap.pake.length || tpap.pake.some((value) => !Number.isFinite(Number(value)))) {
      console.log('TPAP discover: FALLITA (parametri TPAP non utilizzabili)');
      this.protocol = { pake: [2], userHashType: 0, port: this.port, tls: false, fallback: true };
      console.log('TPAP discover fallback pake:[2]: OK');
      return { ...this.protocol };
    }
    const pake = tpap.pake.map(Number);
    this.protocol = {
      pake,
      userHashType: Number(tpap.user_hash_type || 0),
      port: Number(tpap.port || this.port),
      tls: Boolean(tpap.tls),
    };
    if (this.protocol.tls) throw new Error('Il dispositivo richiede TPAP su TLS, non previsto per questa P105 HTTP/80.');
    if (this.protocol.port !== this.port) {
      this.port = this.protocol.port;
      this.baseUrl = this.port === 80 ? `http://${this.ip}` : `http://${this.ip}:${this.port}`;
    }
    console.log('TPAP discover: OK');
    return { ...this.protocol };
  }

  async authenticate() {
    const protocol = this.protocol || await this.discoverProtocol();
    let lastError;
    let failedPhase = 'pake_register';
    for (const secret of candidateSecrets(this.password, protocol.pake)) {
      try {
        await this.authenticateCandidate(protocol, secret, (phase) => { failedPhase = phase; });
        console.log('TPAP pake_register: OK');
        console.log('TPAP pake_share: OK');
        console.log('TPAP sessione stabilita: OK');
        return;
      } catch (error) {
        lastError = error;
        if (error.tpapHttpResponse) {
          const first = this.discoverHttpResponse;
          const second = error.tpapHttpResponse;
          if (first?.bodySha256 && second.bodySha256) {
            console.log(`TPAP HTML SHA-256 discover=${first.bodySha256}`);
            console.log(`TPAP HTML SHA-256 pake_register=${second.bodySha256}`);
            console.log(`TPAP HTML byte-per-byte: ${first.bodySha256 === second.bodySha256 ? 'IDENTICI' : 'DIVERSI'}`);
            console.log(`TPAP HTML significato probabile: ${second.safeSummary}`);
          }
          break;
        }
      }
    }
    console.log(`TPAP ${failedPhase}: FALLITA (${lastError?.message || 'nessun dettaglio disponibile'})`);
    throw new Error(`Autenticazione TPAP non riuscita: ${lastError?.message || 'nessun dettaglio disponibile'}`);
  }

  async authenticateCandidate(protocol, secret, setPhase) {
    const userRandom = crypto.randomBytes(32);
    setPhase('pake_register');
    const register = await this.postJson({
      method: 'login',
      params: {
        sub_method: 'pake_register',
        username: authUsername(protocol.pake, protocol.userHashType),
        user_random: userRandom.toString('base64'),
        cipher_suites: REGISTER_CIPHER_SUITES,
        encryption: REGISTER_ENCRYPTIONS,
        passcode_type: passcodeType(protocol.pake),
        stok: null,
      },
    }, 'TPAP pake_register');
    const suiteType = Number(register.cipher_suites || 1);
    const encryption = String(register.encryption || 'aes_128_ccm');
    const credential = resolveCredential(secret, '', register.extra_crypt);
    const exchange = createSpake2Exchange({
      credential,
      devSalt: Buffer.from(register.dev_salt, 'base64'),
      devShare: Buffer.from(register.dev_share, 'base64'),
      devRandom: Buffer.from(register.dev_random, 'base64'),
      userRandom,
      iterations: Number(register.iterations),
      suiteType,
    });
    setPhase('pake_share');
    const share = await this.postJson({
      method: 'login',
      params: {
        sub_method: 'pake_share',
        user_share: exchange.userShare.toString('base64'),
        user_confirm: exchange.userConfirm.toString('base64'),
      },
    }, 'TPAP pake_share');
    const deviceConfirm = Buffer.from(share.dev_confirm, 'base64');
    if (deviceConfirm.length !== exchange.expectedDeviceConfirm.length
      || !crypto.timingSafeEqual(deviceConfirm, exchange.expectedDeviceConfirm)) {
      throw new Error('Conferma crittografica del dispositivo non valida.');
    }
    setPhase('sessione');
    this.session = new TpapSession({
      sharedKey: exchange.sharedKey,
      hash: exchange.hash,
      encryption,
      stok: String(share.sessionId || share.stok || ''),
      startSequence: Number(share.start_seq),
    });
  }

  async getDeviceInfo() {
    if (!this.session) await this.authenticate();
    const request = JSON.stringify({ method: 'get_device_info', requestTimeMils: Date.now() });
    const encrypted = this.session.encrypt(request);
    try {
      const response = await postTpapBuffer(`${this.baseUrl}${this.session.sessionPath}`, encrypted, {
        timeout: this.timeout,
        agent: this.httpAgent,
        contentType: 'application/octet-stream',
        accept: 'application/octet-stream',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const decrypted = this.session.decrypt(Buffer.from(await response.arrayBuffer()));
      let body;
      try { body = JSON.parse(decrypted); } catch { throw new Error('risposta decifrata non valida'); }
      if (body.error_code !== 0) throw new Error(`error_code=${body.error_code}`);
      console.log('TPAP get_device_info: OK');
      return body.result || {};
    } catch (error) {
      console.log(`TPAP get_device_info: FALLITA (${error.message})`);
      throw new Error(`TPAP get_device_info: ${error.message}`);
    }
  }

  close() {
    this.session?.destroy();
    this.session = null;
    this.password = '';
    this.httpAgent.destroy();
  }
}
