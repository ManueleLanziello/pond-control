import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import http from 'node:http';
import { p256, p384 } from '@noble/curves/nist.js';
import { __test, createSpake2Exchange } from '../src/tpap/spake2.js';
import { TpapSession } from '../src/tpap/session.js';
import { readFile } from 'node:fs/promises';
import { classifyHttpBody, TpapClient } from '../src/tpap/client.js';
import { createTpapHttpAgent, postTpapJson } from '../src/tpap/http.js';

test('AES-CMAC matches the NIST SP 800-38B empty-message vector', () => {
  const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
  assert.equal(__test.cmacAes128(key, Buffer.alloc(0)).toString('hex'), 'bb1d6929e95937287fa37d129b756746');
});

for (const [suiteType, curve] of [[1, p256], [3, p384]]) {
  test(`SPAKE2+ builds a deterministic, valid exchange for suite ${suiteType}`, () => {
    const devShare = Buffer.from(curve.Point.BASE.multiply(7n).toBytes(false));
    const exchange = createSpake2Exchange({
      credential: 'unit-test-only',
      devSalt: Buffer.alloc(16, 0x11),
      devShare,
      devRandom: Buffer.alloc(32, 0x22),
      userRandom: Buffer.alloc(32, 0x33),
      iterations: 100,
      suiteType,
      randomBytes: () => Buffer.alloc(48, 0x44),
    });
    curve.Point.fromBytes(exchange.userShare).assertValidity();
    assert.ok(exchange.userConfirm.length > 0);
    assert.ok(exchange.expectedDeviceConfirm.length > 0);
    assert.ok(exchange.sharedKey.length >= 32);
  });
}

for (const encryption of ['aes_128_ccm', 'aes_256_ccm', 'chacha20_poly1305']) {
  test(`TPAP session ${encryption} round-trip`, () => {
    const first = new TpapSession({ sharedKey: crypto.randomBytes(32), hash: 'sha256', encryption, stok: 'test', startSequence: 5 });
    const second = Object.create(Object.getPrototypeOf(first));
    Object.assign(second, first, { key: Buffer.from(first.key), baseNonce: Buffer.from(first.baseNonce) });
    const encrypted = first.encrypt('{"method":"get_device_info"}');
    assert.equal(second.decrypt(encrypted), '{"method":"get_device_info"}');
    first.destroy();
    second.destroy();
  });
}

test('read-only status source contains no mutating device method', async () => {
  const sources = await Promise.all([
    readFile(new URL('../status.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/tpap/client.js', import.meta.url), 'utf8'),
  ]);
  const combined = sources.join('\n');
  assert.doesNotMatch(combined, /set_device_info|turnOn|turnOff|device_on\s*:/);
  assert.match(combined, /get_device_info/);
});

test('HTTP diagnostic recognizes JSON with a UTF-8 BOM', () => {
  const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"error_code":0}')]);
  const result = classifyHttpBody(body, 'application/json');
  assert.equal(result.format, 'JSON UTF-8 con BOM');
  assert.equal(JSON.parse(result.text).error_code, 0);
});

test('HTTP diagnostic recognizes HTML without exposing its body', () => {
  const result = classifyHttpBody(Buffer.from('<html><body>private</body></html>'), 'text/html');
  assert.equal(result.format, 'HTML');
  assert.equal(result.text, null);
});

test('HTTP diagnostic recognizes compressed and non-UTF-8 bodies', () => {
  assert.equal(classifyHttpBody(Buffer.from([0x1f, 0x8b, 0x08])).format, 'binario compresso (gzip)');
  assert.equal(classifyHttpBody(Buffer.from([0xff, 0xfe, 0xfd])).format, 'binario/non UTF-8');
});

test('TPAP discover HTTP 200 text/html falls back to pake:[2]', async () => {
  const originalLog = console.log;
  const logs = [];
  const jsonTransport = async () => new Response('<html><body>not JSON</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html', 'Content-Length': '39' },
  });
  console.log = (...values) => logs.push(values.join(' '));
  try {
    const client = new TpapClient({ ip: '192.0.2.1', username: 'not-logged', password: 'not-logged', jsonTransport });
    const protocol = await client.discoverProtocol();
    assert.deepEqual(protocol.pake, [2]);
    assert.equal(protocol.fallback, true);
    assert.ok(logs.some((line) => line.includes('formato HTML') || line.includes('(HTML)')));
    assert.ok(logs.some((line) => line.includes('fallback pake:[2]: OK')));
    assert.ok(logs.every((line) => !line.includes('not-logged')));
  } finally {
    console.log = originalLog;
  }
});

test('TPAP pake_register matches the minimal reference wire structure', async () => {
  const requests = [];
  const jsonTransport = async (url, body, options) => {
    requests.push({ url, options, body });
    return new Response('<html>TP-Link</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  };
  try {
    const client = new TpapClient({
      ip: '192.0.2.1', username: 'unused@example.invalid', password: 'test-only', jsonTransport,
    });
    client.protocol = { pake: [2], userHashType: 0, port: 80, tls: false };
    await assert.rejects(client.authenticate(), /pake_register/);
    assert.equal(requests[0].url, 'http://192.0.2.1');
    assert.deepEqual(requests[0].body.params.cipher_suites, [1]);
    assert.deepEqual(requests[0].body.params.encryption, ['aes_128_ccm']);
    assert.equal(requests[0].body.params.sub_method, 'pake_register');
  } finally { /* no global transport modified */ }
});

test('native TPAP HTTP sends explicit Content-Length without chunked encoding', async () => {
  let observed;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      observed = { headers: request.headers, rawHeaders: request.rawHeaders, body: Buffer.concat(chunks) };
      response.setHeader('Content-Type', 'application/json');
      response.end('{"error_code":0,"result":{}}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const agent = createTpapHttpAgent();
  try {
    const address = server.address();
    const payload = { method: 'login', params: { sub_method: 'discover' } };
    await postTpapJson(`http://127.0.0.1:${address.port}`, payload, { agent });
    assert.equal(observed.headers['content-length'], String(Buffer.byteLength(JSON.stringify(payload), 'utf8')));
    assert.equal(observed.headers['transfer-encoding'], undefined);
    assert.equal(observed.headers.connection.toLowerCase(), 'keep-alive');
    assert.equal(observed.headers['user-agent'], undefined);
    assert.equal(observed.headers['accept-encoding'], undefined);
  } finally {
    agent.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
