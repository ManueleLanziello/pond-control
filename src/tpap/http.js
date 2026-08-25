import http from 'node:http';

export function createTpapHttpAgent() {
  return new http.Agent({ keepAlive: true, maxSockets: 1 });
}

export function postTpapBuffer(url, bodyInput, { timeout = 5000, agent, contentType, accept } = {}) {
  const target = new URL(url);
  const body = Buffer.isBuffer(bodyInput) ? bodyInput : Buffer.from(bodyInput, 'utf8');

  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: 'http:',
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname || '/',
      method: 'POST',
      agent,
      headers: {
        Host: target.port && target.port !== '80' ? `${target.hostname}:${target.port}` : target.hostname,
        'Content-Type': contentType,
        Accept: accept,
        Connection: 'Keep-Alive',
        'Content-Length': body.length,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        resolve({
          status: response.statusCode || 0,
          ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
          redirected: false,
          headers: { get: (name) => response.headers[String(name).toLowerCase()]?.toString() || null },
          arrayBuffer: async () => responseBody,
        });
      });
    });

    request.setTimeout(timeout, () => request.destroy(new Error(`Timeout HTTP TPAP dopo ${timeout} ms`)));
    request.on('error', reject);
    request.end(body);
  });
}

export function postTpapJson(url, payload, options = {}) {
  const body = JSON.stringify(payload);
  return postTpapBuffer(url, body, {
    ...options,
    contentType: 'application/json; charset=UTF-8',
    accept: 'application/json',
  });
}
