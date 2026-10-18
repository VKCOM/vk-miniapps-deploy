'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const marker = '@@RESULT@@';

function runChild(script, input, env) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    env: Object.assign({}, process.env, env),
    input: input,
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const markerIndex = result.stdout.lastIndexOf(marker);
  assert.notEqual(markerIndex, -1, result.stdout);
  return JSON.parse(result.stdout.slice(markerIndex + marker.length).trim());
}

function promptScript(expression) {
  return [
    "const prompts = require('./readline-prompt');",
    '(async () => {',
    '  const result = await (async () => ' + expression + ')();',
    '  prompts.close();',
    "  process.stdout.write('\\n" + marker + "' + JSON.stringify(result) + '\\n');",
    '})().catch((error) => { console.error(error); process.exitCode = 1; });',
  ].join('\n');
}

test('confirm uses its default for an empty answer', () => {
  assert.equal(runChild(promptScript("prompts.confirm('continue?', true)"), '\n'), true);
  assert.equal(runChild(promptScript("prompts.confirm('continue?', false)"), '\n'), false);
});

test('EOF cancels confirm instead of accepting the default', () => {
  const expression = "({answer: await prompts.confirm('continue?', true)})";
  assert.deepEqual(runChild(promptScript(expression), ''), {});
});

test('text returns input and already-piped answers remain queued', () => {
  assert.equal(runChild(promptScript("prompts.text('code?')"), '1234\n'), '1234');

  const script = [
    "const prompts = require('./readline-prompt');",
    '(async () => {',
    "  const confirmed = await prompts.confirm('continue?', false);",
    "  const value = await prompts.text('code?');",
    '  prompts.close();',
    "  process.stdout.write('\\n" + marker + "' + JSON.stringify([confirmed, value]) + '\\n');",
    '})().catch((error) => { console.error(error); process.exitCode = 1; });',
  ].join('\n');
  assert.deepEqual(runChild(script, 'yes\n1234\n'), [true, '1234']);
});

function terminalScript(stdinIsTTY, questions) {
  return [
    // readline reads keys only when it writes to a terminal
    'process.stdout.isTTY = true;',
    'process.stdin.isTTY = ' + stdinIsTTY + ';',
    "const prompts = require('./readline-prompt');",
    '(async () => {',
    '  const answers = [];',
    ...questions.map((question) => '  answers.push(await prompts.' + question + ');'),
    '  prompts.close();',
    "  process.stdout.write('\\n" + marker + "' + JSON.stringify(answers) + '\\n');",
    '})().catch((error) => { console.error(error); process.exitCode = 1; });',
  ].join('\n');
}

// Sends each answer once its question is shown, as a person types
async function answerEach(t, stdinIsTTY, steps) {
  const questions = ["confirm('first?', false)", "confirm('second?', true)", "text('code?')"];
  const child = spawn(process.execPath, ['-e', terminalScript(stdinIsTTY, questions)], {
    cwd: path.resolve(__dirname, '..'),
  });
  t.after(() => child.kill());
  const prompts = ['first?', 'second?', 'code?'];
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (prompts.length && stdout.includes(prompts[0])) {
      prompts.shift();
      child.stdin.write(steps.shift());
    }
  });
  await new Promise((resolve) => child.once('close', resolve));
  return JSON.parse(stdout.slice(stdout.lastIndexOf(marker) + marker.length));
}

test('in a terminal y and n answer without Enter', { timeout: 5000 }, async (t) => {
  assert.deepEqual(await answerEach(t, true, ['y', 'n', '1234\r']), [true, false, '1234']);

  // In a pasted chunk the key answers only its own question
  const pasted = terminalScript(true, ["confirm('continue?', false)", "text('name?')"]);
  assert.deepEqual(runChild(pasted, 'yyandex\r'), [true, 'yandex']);
});

test(
  'piped answers wait for Enter even when the output is a terminal',
  { timeout: 5000 },
  async (t) => {
    assert.deepEqual(await answerEach(t, false, ['yes\n', 'no\n', '1234\n']), [
      true,
      false,
      '1234',
    ]);
  },
);

test('Ctrl-C after the last answer interrupts the program', { timeout: 5000 }, async (t) => {
  const script = [
    // readline handles Ctrl-C itself only when it writes to a terminal
    'process.stdout.isTTY = true;',
    "const prompts = require('./readline-prompt');",
    '(async () => {',
    "  await prompts.confirm('continue?', true);",
    "  process.stdout.write('answered\\n');",
    "  setTimeout(() => process.stdout.write('finished\\n'), 2000);",
    '})();',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..') });
  t.after(() => child.kill());
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.includes('finished')) child.kill();
    else if (stdout.includes('answered')) child.stdin.write('\x03');
  });
  child.stdin.write('y\n');
  await new Promise((resolve) => child.once('close', resolve));

  assert.match(stdout, /answered/);
  assert.doesNotMatch(stdout, /finished/);
});

test('token store reads configstore JSON and writes with private POSIX modes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-token-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configHome = path.join(root, 'config-home');
  const configPath = path.join(
    configHome,
    'configstore',
    require('../package.json').name + '.json',
  );
  const storePath = path.resolve(__dirname, '..', 'token-store.js');
  const writeScript = [
    'const store = require(' + JSON.stringify(storePath) + ');',
    "store.save({ access_token: 'new-token', expires_in: 123 });",
    "process.stdout.write('" + marker + "' + JSON.stringify(store.read()));",
  ].join('\n');

  assert.deepEqual(runChild(writeScript, undefined, { XDG_CONFIG_HOME: configHome }), {
    access_token: 'new-token',
    expires_in: 123,
  });
  assert.equal(fs.existsSync(configPath), true);
  const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(written, { access_token: 'new-token', expires_in: 123 });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(configPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  }

  fs.writeFileSync(
    configPath,
    JSON.stringify({ access_token: 'configstore-token', expires_in: 456 }, undefined, '\t'),
  );
  const readScript = [
    'const store = require(' + JSON.stringify(storePath) + ');',
    "process.stdout.write('" + marker + "' + JSON.stringify(store.read()));",
  ].join('\n');
  assert.deepEqual(runChild(readScript, undefined, { XDG_CONFIG_HOME: configHome }), {
    access_token: 'configstore-token',
    expires_in: 456,
  });
});

test('a damaged token file reads as empty and the next save replaces it with mode 0600', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-token-damaged-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configHome = path.join(root, 'config-home');
  const storePath = path.resolve(__dirname, '..', 'token-store.js');
  const configPath = path.join(
    configHome,
    'configstore',
    require('../package.json').name + '.json',
  );
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // What an interrupted write leaves behind
  fs.writeFileSync(configPath, '{"access_tok', { mode: 0o644 });
  const script = [
    'const store = require(' + JSON.stringify(storePath) + ');',
    'const before = store.read();',
    "store.save({ access_token: 'new-token', expires_in: 789 });",
    "process.stdout.write('" + marker + "' + JSON.stringify([before, store.read()]));",
  ].join('\n');

  assert.deepEqual(runChild(script, undefined, { XDG_CONFIG_HOME: configHome }), [
    {},
    { access_token: 'new-token', expires_in: 789 },
  ]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  }
});
