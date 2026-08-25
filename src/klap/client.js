import crypto from 'node:crypto';
import http from 'node:http';
import {
  deriveKlapV2AuthHash,
  klapV2Handshake1Challenge,
  klapV2Handshake2Challenge,
  KlapV2Session,
} from './session.js';

function sessionCookie(setCookieHeaders) {
  for (const header of setCookieHeaders || []) {
    const match = String(header).match(/(?:^|;\s*)TP_SESSIONID=([^;]+)/i);
    if (match) return `TP_SESSIONID=${match[1]}`;
  }
  return null;
}

function postBinary({ ip, port, path, body, timeout, agent, cookie }) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': body.length,
      Connection: 'Keep-Alive',
    };
    if (cookie) headers.Cookie = cookie;
    const request = http.request({ hostname: ip, port, path, method: 'POST', headers, agent }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks),
        setCookie: response.headers['set-cookie'] || [],
      }));
    });
    request.setTimeout(timeout, () => request.destroy(new Error(`Timeout HTTP KLAP dopo ${timeout} ms`)));
    request.on('error', reject);
    request.end(body);
  });
}

function phaseFailure(phase, error) {
  console.log(`KLAP ${phase}: FALLITA (${error.message})`);
  throw error;
}

export class KlapV2Client {
  constructor({ ip, username, password, port = 80, timeout = 5000 }) {
    this.ip = ip;
    this.username = username;
    this.password = password;
    this.port = port;
    this.timeout = timeout;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    this.cookie = null;
    this.session = null;
  }

  async authenticate() {
    const localSeed = crypto.randomBytes(16);
    let remoteSeed;
    let authHash;
    try {
      let first;
      try {
        first = await postBinary({
          ip: this.ip, port: this.port, path: '/app/handshake1', body: localSeed,
          timeout: this.timeout, agent: this.agent,
        });
        if (first.status !== 200) throw new Error(`HTTP ${first.status}`);
        if (first.body.length !== 48) throw new Error(`risposta binaria di ${first.body.length} byte, attesi 48`);
        this.cookie = sessionCookie(first.setCookie);
        if (!this.cookie) throw new Error('cookie di sessione TP_SESSIONID assente');
        remoteSeed = Buffer.from(first.body.subarray(0, 16));
        console.log('KLAP handshake1: OK');
      } catch (error) {
        return phaseFailure('handshake1', error);
      }

      try {
        authHash = deriveKlapV2AuthHash(this.username, this.password);
        const expected = klapV2Handshake1Challenge(localSeed, remoteSeed, authHash);
        const received = first.body.subarray(16);
        if (!crypto.timingSafeEqual(expected, received)) throw new Error('credenziali non riconosciute dal challenge KLAP v2');
        console.log('KLAP challenge credenziali: OK');
      } catch (error) {
        return phaseFailure('challenge credenziali', error);
      }

      try {
        const challenge = klapV2Handshake2Challenge(localSeed, remoteSeed, authHash);
        const second = await postBinary({
          ip: this.ip, port: this.port, path: '/app/handshake2', body: challenge,
          timeout: this.timeout, agent: this.agent, cookie: this.cookie,
        });
        challenge.fill(0);
        if (second.status !== 200) throw new Error(`HTTP ${second.status}`);
        console.log('KLAP handshake2: OK');
      } catch (error) {
        return phaseFailure('handshake2', error);
      }

      try {
        this.session = new KlapV2Session(localSeed, remoteSeed, authHash);
        console.log('KLAP sessione stabilita: OK');
      } catch (error) {
        return phaseFailure('sessione stabilita', error);
      }
    } finally {
      localSeed.fill(0);
      remoteSeed?.fill(0);
      authHash?.fill(0);
    }
  }

  async getDeviceInfo() {
    if (!this.session) await this.authenticate();
    try {
      const request = JSON.stringify({ method: 'get_device_info', requestTimeMils: Date.now() });
      const encrypted = this.session.encrypt(request);
      const response = await postBinary({
        ip: this.ip,
        port: this.port,
        path: `/app/request?seq=${encrypted.sequence}`,
        body: encrypted.payload,
        timeout: this.timeout,
        agent: this.agent,
        cookie: this.cookie,
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const plaintext = this.session.decrypt(response.body, encrypted.sequence);
      let decoded;
      try { decoded = JSON.parse(plaintext); } catch { throw new Error('risposta decifrata non è JSON valido'); }
      if (decoded.error_code !== 0) throw new Error(`error_code=${decoded.error_code}`);
      console.log('KLAP get_device_info: OK');
      return decoded.result || {};
    } catch (error) {
      console.log(`KLAP get_device_info: FALLITA (${error.message})`);
      throw error;
    }
  }

  close() {
    this.session?.destroy();
    this.session = null;
    this.cookie = null;
    this.username = '';
    this.password = '';
    this.agent.destroy();
  }
}

export const __test = { postBinary, sessionCookie };
