import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { KlapV2Client } from '../src/klap/client.js';
import {
  deriveKlapV2AuthHash,
  klapV2Handshake1Challenge,
  klapV2Handshake2Challenge,
  KlapV2Session,
} from '../src/klap/session.js';

const sha256 = (...parts) => {
  const hash = crypto.createHash('sha256');
  parts.forEach((part) => hash.update(part));
  return hash.digest();
};

test('KLAP v2 auth hash and challenges match independent derivation', () => {
  const username = 'test@example.invalid';
  const password = 'unit-test-password';
  const local = Buffer.alloc(16, 0x11);
  const remote = Buffer.alloc(16, 0x22);
  const expectedAuth = sha256(
    crypto.createHash('sha1').update(username).digest(),
    crypto.createHash('sha1').update(password).digest(),
  );
  const auth = deriveKlapV2AuthHash(username, password);
  assert.deepEqual(auth, expectedAuth);
  assert.deepEqual(klapV2Handshake1Challenge(local, remote, auth), sha256(local, remote, auth));
  assert.deepEqual(klapV2Handshake2Challenge(local, remote, auth), sha256(remote, local, auth));
  assert.notDeepEqual(
    klapV2Handshake1Challenge(local, remote, auth),
    klapV2Handshake1Challenge(local, remote, deriveKlapV2AuthHash(username, 'wrong')),
  );
});

test('KLAP session derives keys, signs, encrypts, decrypts, and increments signed sequence', () => {
  const local = Buffer.alloc(16, 0x31);
  const remote = Buffer.alloc(16, 0x42);
  const auth = Buffer.alloc(32, 0x53);
  const session = new KlapV2Session(local, remote, auth);
  assert.deepEqual(session.key, sha256(Buffer.from('lsk'), local, remote, auth).subarray(0, 16));
  assert.deepEqual(session.ivPrefix, sha256(Buffer.from('iv'), local, remote, auth).subarray(0, 12));
  assert.deepEqual(session.signatureKey, sha256(Buffer.from('ldk'), local, remote, auth).subarray(0, 28));
  const initial = session.sequence;
  const first = session.encrypt('{"test":1}');
  assert.equal(first.sequence, (initial + 1) | 0);
  assert.equal(session.decrypt(first.payload, first.sequence), '{"test":1}');
  const second = session.encrypt('{"test":2}');
  assert.equal(second.sequence, (first.sequence + 1) | 0);
  assert.equal(session.decrypt(second.payload, second.sequence), '{"test":2}');
  session.destroy();
});

test('KLAP client completes v2 handshake and sends only get_device_info', async () => {
  const username = 'local-test@example.invalid';
  const password = 'local-test-password';
  const remoteSeed = Buffer.alloc(16, 0x77);
  const authHash = deriveKlapV2AuthHash(username, password);
  const sensitiveCookie = 'do-not-log-this-cookie';
  const observed = [];
  let serverSession;
  let localSeed;

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      observed.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.url === '/app/handshake1') {
        localSeed = Buffer.from(body);
        response.setHeader('Set-Cookie', [`TP_SESSIONID=${sensitiveCookie}; Path=/`, 'TIMEOUT=86400']);
        response.end(Buffer.concat([remoteSeed, klapV2Handshake1Challenge(localSeed, remoteSeed, authHash)]));
        return;
      }
      if (request.url === '/app/handshake2') {
        assert.equal(request.headers.cookie, `TP_SESSIONID=${sensitiveCookie}`);
        assert.deepEqual(body, klapV2Handshake2Challenge(localSeed, remoteSeed, authHash));
        serverSession = new KlapV2Session(localSeed, remoteSeed, authHash);
        response.end();
        return;
      }
      if (request.url.startsWith('/app/request?seq=')) {
        assert.equal(request.headers.cookie, `TP_SESSIONID=${sensitiveCookie}`);
        const sequence = Number(new URL(request.url, 'http://local').searchParams.get('seq'));
        const plaintext = serverSession.decrypt(body, sequence);
        const decoded = JSON.parse(plaintext);
        assert.deepEqual(Object.keys(decoded).sort(), ['method', 'requestTimeMils']);
        assert.equal(decoded.method, 'get_device_info');
        serverSession.sequence = (sequence - 1) | 0;
        const encrypted = serverSession.encrypt(JSON.stringify({
          error_code: 0,
          result: {
            model: 'P100M(EU)', nickname: Buffer.from('Presa test').toString('base64'),
            type: 'SMART.TAPOPLUG', device_on: false, rssi: -51,
          },
        }));
        assert.equal(encrypted.sequence, sequence);
        response.end(encrypted.payload);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const logs = [];
  const originalLog = console.log;
  console.log = (...values) => logs.push(values.join(' '));
  const address = server.address();
  const client = new KlapV2Client({ ip: '127.0.0.1', port: address.port, username, password });
  try {
    const info = await client.getDeviceInfo();
    assert.equal(info.model, 'P100M(EU)');
    assert.equal(info.device_on, false);
    assert.deepEqual(observed.map((item) => item.url.split('?')[0]), [
      '/app/handshake1', '/app/handshake2', '/app/request',
    ]);
    assert.ok(observed.every((item) => item.method === 'POST'));
    const output = logs.join('\n');
    for (const phase of ['handshake1', 'challenge credenziali', 'handshake2', 'sessione stabilita', 'get_device_info']) {
      assert.match(output, new RegExp(`KLAP ${phase}: OK`));
    }
    assert.doesNotMatch(output, new RegExp([sensitiveCookie, username, password].join('|')));
  } finally {
    console.log = originalLog;
    client.close();
    serverSession?.destroy();
    authHash.fill(0);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('KLAP public client remains strictly read-only', async () => {
  const sources = await Promise.all([
    readFile(new URL('../src/klap/client.js', import.meta.url), 'utf8'),
    readFile(new URL('../klap-status.js', import.meta.url), 'utf8'),
  ]);
  const source = sources.join('\n');
  assert.match(source, /get_device_info/);
  assert.doesNotMatch(source, /set_device_info|device_on\s*:|turnOn|turnOff|sendCommand|sendRequest|executeCommand/);
  const methods = Object.getOwnPropertyNames(KlapV2Client.prototype).filter((name) => name !== 'constructor');
  assert.deepEqual(methods.sort(), ['authenticate', 'close', 'getDeviceInfo'].sort());
});
