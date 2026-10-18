'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const cliPath = path.resolve(__dirname, '..', 'bin', 'vk-miniapps-deploy');

async function runCli(input) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { error_code: 5, error_msg: 'local stub' } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-cli-cancel-'));
  fs.mkdirSync(path.join(root, 'static'));
  fs.writeFileSync(path.join(root, 'static', 'index.html'), 'fixture');
  fs.writeFileSync(
    path.join(root, 'vk-hosting-config.json'),
    JSON.stringify({
      api_host: 'http://127.0.0.1:' + server.address().port + '/method/',
      app_id: 123,
      access_token: 'test-token',
      static_path: 'static',
      endpoints: {},
      noprompt: false,
    }),
  );

  try {
    const result = await new Promise((resolve, reject) => {
      const env = Object.assign({}, process.env, {
        MINI_APPS_ACCESS_TOKEN: '',
        MINI_APPS_APP_ID: '',
        MINI_APPS_ENVIRONMENT: '',
      });
      ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].forEach(
        (key) => delete env[key],
      );
      const child = spawn(process.execPath, [cliPath], {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('CLI did not finish within 4500 ms'));
      }, 4500);
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      child.stdin.end(input);
    });

    return { ...result, requests };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('EOF at the initial confirmation exits without API requests', { timeout: 5000 }, async () => {
  const result = await runCli('');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.requests, []);
});

test(
  'EOF after the initial confirmation exits without API requests',
  { timeout: 5000 },
  async () => {
    const result = await runCli('y\n');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.requests, []);
  },
);

test('EOF after one deployment option exits without API requests', { timeout: 5000 }, async () => {
  const result = await runCli('y\ny\n');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.requests, []);
});

test(
  'EOF at the test-group confirmation cancels before deployment',
  { timeout: 5000 },
  async () => {
    const result = await runCli('y\ny\ny\n');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.requests, []);
  },
);

test(
  'EOF at the test-group name cancels without sending an undefined name',
  { timeout: 5000 },
  async () => {
    const result = await runCli('y\ny\ny\ny\n');
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.requests, []);
    assert.equal(
      result.requests.some((request) => request.includes('test_group_name=undefined')),
      false,
    );
  },
);

test(
  'answering no to the test-group question still starts deployment',
  { timeout: 5000 },
  async () => {
    const result = await runCli('y\ny\ny\nn\n');
    assert.equal(result.requests.length, 1, result.stderr);
    assert.match(result.requests[0], /^\/method\/apps\.getGoHostingUploadServer\?/);
    assert.equal(result.requests[0].includes('test_group_name='), false);
  },
);

test(
  'a supplied test-group name reaches the first deployment request',
  { timeout: 5000 },
  async () => {
    const result = await runCli('y\ny\ny\ny\ngrp\n');
    assert.equal(result.requests.length, 1, result.stderr);
    assert.match(result.requests[0], /^\/method\/apps\.getGoHostingUploadServer\?/);
    assert.equal(
      new URL(result.requests[0], 'http://127.0.0.1').searchParams.get('test_group_name'),
      'grp',
    );
  },
);

test(
  'an empty test-group name starts deployment without a test_group_name parameter',
  { timeout: 5000 },
  async () => {
    const result = await runCli('y\ny\ny\ny\n\n');
    assert.equal(result.requests.length, 1, result.stderr);
    assert.match(result.requests[0], /^\/method\/apps\.getGoHostingUploadServer\?/);
    assert.equal(
      new URL(result.requests[0], 'http://127.0.0.1').searchParams.has('test_group_name'),
      false,
    );
  },
);
