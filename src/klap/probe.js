import crypto from 'node:crypto';
import http from 'node:http';

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  return value === undefined ? 'non dichiarato' : String(value);
}

export function classifyKlapProbeBody(body, contentType = '') {
  if (body.length === 0) return 'vuoto';
  if (/application\/octet-stream/i.test(contentType)) return 'binario';

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body).trim();
  } catch {
    return 'binario';
  }
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text)) return 'HTML';
  try {
    JSON.parse(text);
    return 'JSON';
  } catch {
    return 'altro';
  }
}

export function probeKlapHandshake1(ip, { port = 80, timeout = 5000, randomBytes = crypto.randomBytes } = {}) {
  const localSeed = randomBytes(16);
  if (!Buffer.isBuffer(localSeed) || localSeed.length !== 16) {
    throw new Error('Il generatore del seed KLAP deve restituire esattamente 16 byte.');
  }
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: ip,
      port,
      path: '/app/handshake1',
      method: 'POST',
      agent,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': 16,
        Connection: 'Keep-Alive',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        const contentType = headerValue(response.headers, 'content-type');
        const report = {
          ip,
          status: response.statusCode || 0,
          contentType,
          contentLength: headerValue(response.headers, 'content-length'),
          contentEncoding: headerValue(response.headers, 'content-encoding'),
          hasSetCookie: Array.isArray(response.headers['set-cookie']) || Boolean(response.headers['set-cookie']),
          bodyLength: body.length,
          format: classifyKlapProbeBody(body, contentType),
        };
        localSeed.fill(0);
        agent.destroy();
        resolve(report);
      });
    });

    request.setTimeout(timeout, () => request.destroy(new Error(`Timeout KLAP handshake1 dopo ${timeout} ms`)));
    request.on('error', (error) => {
      localSeed.fill(0);
      agent.destroy();
      reject(error);
    });
    request.end(localSeed);
  });
}

export function printKlapProbeReport(report, log = console.log) {
  log(`IP: ${report.ip}`);
  log(`HTTP status: ${report.status}`);
  log(`Content-Type: ${report.contentType}`);
  log(`Content-Length: ${report.contentLength}`);
  log(`Content-Encoding: ${report.contentEncoding}`);
  log(`Set-Cookie presente: ${report.hasSetCookie ? 'SI' : 'NO'}`);
  log(`Body length: ${report.bodyLength} byte`);
  log(`Formato: ${report.format}`);
}
