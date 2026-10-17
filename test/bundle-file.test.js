'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { test } = require('node:test');

test('missing bundle file stops the deploy before upload', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url.split('?')[0]);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ response: { upload_url: base + '/upload' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;

  fs.mkdirSync(path.join(root, 'static'));
  fs.writeFileSync(path.join(root, 'static', 'index.html'), '');
  fs.writeFileSync(
    path.join(root, 'vk-hosting-config.json'),
    JSON.stringify({
      app_id: 1,
      static_path: 'static',
      bundleFile: './missing.zip',
      endpoints: { web: 'index.html' },
      api_host: base + '/method/',
      noprompt: true,
    }),
  );

  const bin = path.resolve(__dirname, '..', 'bin', 'vk-miniapps-deploy');
  const child = spawn(process.execPath, [bin], {
    cwd: root,
    env: {
      ...process.env,
      MINI_APPS_ACCESS_TOKEN: 'token',
      MINI_APPS_APP_ID: '',
      MINI_APPS_ENVIRONMENT: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      HOME: root,
      USERPROFILE: root,
      APPDATA: root,
      XDG_CONFIG_HOME: root,
    },
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const timer = setTimeout(() => child.kill(), 10000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);

  assert.equal(code, 1);
  assert.match(output, /Empty bundle file: \.\/missing\.zip/);
  assert.deepEqual(requests, ['/method/apps.getGoHostingUploadServer']);
});
