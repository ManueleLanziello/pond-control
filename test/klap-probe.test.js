import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { printKlapProbeReport, probeKlapHandshake1 } from '../src/klap/probe.js';

test('KLAP probe sends only a 16-byte handshake1 request and logs metadata only', async () => {
  let observed;
  const responseBody = Buffer.alloc(48, 0xa5);
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      observed = { method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks) };
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', responseBody.length);
      response.setHeader('Set-Cookie', 'TP_SESSIONID=test-secret-cookie; Timeout=86400');
      response.end(responseBody);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const report = await probeKlapHandshake1('127.0.0.1', {
      port: address.port,
      randomBytes: (length) => Buffer.alloc(length, 0x5a),
    });
    assert.equal(observed.method, 'POST');
    assert.equal(observed.path, '/app/handshake1');
    assert.equal(observed.headers['content-type'], 'application/octet-stream');
    assert.equal(observed.headers['content-length'], '16');
    assert.equal(observed.headers['transfer-encoding'], undefined);
    assert.equal(observed.body.length, 16);
    assert.deepEqual(observed.body, Buffer.alloc(16, 0x5a));

    const logs = [];
    printKlapProbeReport(report, (line) => logs.push(line));
    const output = logs.join('\n');
    assert.match(output, /Set-Cookie presente: SI/);
    assert.match(output, /Body length: 48 byte/);
    assert.match(output, /Formato: binario/);
    assert.doesNotMatch(output, /test-secret-cookie|a5a5|5a5a|seed|challenge|hash/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('KLAP probe source contains no handshake2 or device commands', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/klap/probe.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /handshake2|get_device_info|set_device_info|turnOn|turnOff|device_on/);
});
