'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { fetch: undiciFetch, ProxyAgent } = require('undici');
const createFetch = require('../fetch-request');
const createProxyAgent = require('../proxy-agent');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve('http://127.0.0.1:' + server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('proxy credentials are sent when either URL component is present', async (t) => {
  const authorizations = [];
  const server = http.createServer();
  server.on('connect', (request, socket) => {
    authorizations.push(request.headers['proxy-authorization']);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () =>
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'),
    );
  });
  const proxy = await listen(server);
  t.after(() => close(server));

  const cases = [
    { url: proxy.replace('://', '://user:@'), credentials: 'user:' },
    { url: proxy.replace('://', '://user@'), credentials: 'user:' },
    { url: proxy.replace('://', '://us%40er:p%3Ass@'), credentials: 'us@er:p:ss' },
    { url: proxy, credentials: undefined },
  ];

  for (const testCase of cases) {
    const agent = createProxyAgent(testCase.url, ProxyAgent);
    try {
      const response = await undiciFetch('http://example.test/upload', { dispatcher: agent });
      assert.equal(await response.text(), 'ok');
    } finally {
      await agent.close();
    }
  }

  assert.deepEqual(
    authorizations,
    cases.map((testCase) =>
      testCase.credentials === undefined
        ? undefined
        : 'Basic ' + Buffer.from(testCase.credentials).toString('base64'),
    ),
  );
});

function writeBundle(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-upload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'build.zip');
  const contents = crypto.randomBytes(1024 * 1024);
  fs.writeFileSync(file, contents);
  return { file, contents };
}

async function uploadOptions(file) {
  const form = new FormData();
  form.append('file', await fs.openAsBlob(file, { type: 'application/zip' }), 'build.zip');
  return { method: 'POST', body: form };
}

function assertUploadedBundle(body, contents) {
  assert.ok(body.includes('filename="build.zip"'), 'file name is missing');
  assert.ok(body.includes(contents), 'bundle contents are incomplete');
}

test('upload is sent in full again after the connection drops mid-transfer', async (t) => {
  const { file, contents } = writeBundle(t);
  const bodies = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    let received = 0;
    const attempt = bodies.length;
    bodies.push(null);
    request.on('data', (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (attempt === 0 && received >= 64 * 1024) {
        bodies[attempt] = Buffer.concat(chunks);
        request.socket.destroy();
      }
    });
    request.on('end', () => {
      bodies[attempt] = Buffer.concat(chunks);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const fetch = createFetch(() => ({ fetch: globalThis.fetch }), false);
  t.mock.method(console, 'warn', () => {});

  const response = await fetch(origin + '/upload', await uploadOptions(file), 3, 0);

  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].length < contents.length, 'first attempt was not interrupted');
  assertUploadedBundle(bodies[1], contents);
});

test('permanent HTTP 500 exhausts exactly three full uploads', async (t) => {
  const { file, contents } = writeBundle(t);
  const bodies = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks));
      response.writeHead(500);
      response.end('retry');
    });
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const fetch = createFetch(() => ({ fetch: globalThis.fetch }), false);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});

  await assert.rejects(fetch(origin + '/upload', await uploadOptions(file), 3, 0), /HTTP 500/);
  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assertUploadedBundle(body, contents);
  }
});

test('network error names the endpoint without its query string', async (t) => {
  const server = http.createServer((request) => request.socket.destroy());
  const origin = await listen(server);
  t.after(() => close(server));

  const fetch = createFetch(() => ({ fetch: globalThis.fetch }), false);
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});

  await assert.rejects(
    fetch(origin + '/method/apps.getGoHostingUploadServer?access_token=secret', {}, 2, 0),
    (thrown) => {
      assert.match(thrown.message, /\/method\/apps\.getGoHostingUploadServer failed: fetch failed/);
      return true;
    },
  );
  const output = [...warn.mock.calls, ...error.mock.calls]
    .flatMap((call) => call.arguments)
    .join('\n');
  assert.match(
    output,
    /Request to http:\/\/127\.0\.0\.1:\d+\/method\/apps\.getGoHostingUploadServer failed/,
  );
  assert.doesNotMatch(output, /secret/);
});

test('failed HTTP response does not keep the proxy agent open', async (t) => {
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(500);
    response.write('partial');
  });
  const origin = await listen(server);
  const proxyServer = http.createServer();
  proxyServer.on('connect', (request, socket) => {
    const [host, port] = request.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  const proxy = await listen(proxyServer);
  t.after(async () => {
    server.closeAllConnections();
    proxyServer.closeAllConnections();
    await close(server);
    await close(proxyServer);
  });

  const agent = new ProxyAgent(proxy);
  const fetch = createFetch(() => ({ fetch: undiciFetch, dispatcher: agent }), false);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});

  await assert.rejects(fetch(origin + '/method/test', {}, 2, 0), /HTTP 500/);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), 1000);
  });
  assert.equal(await Promise.race([agent.close().then(() => 'closed'), timeout]), 'closed');
  clearTimeout(timer);
});

test('debug log hides access_token', async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"response":1}');
  });
  const origin = await listen(server);
  t.after(() => close(server));

  const fetch = createFetch(() => ({ fetch: globalThis.fetch }), true);
  const log = t.mock.method(console, 'log', () => {});

  await fetch(origin + '/method/test?access_token=secret&v=5.131', { method: 'POST' });
  const output = log.mock.calls.flatMap((call) => call.arguments).join('\n');
  assert.match(output, /access_token=<redacted>/);
  assert.doesNotMatch(output, /secret/);
});
