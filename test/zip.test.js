'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomBytes } = require('crypto');
const { Writable } = require('stream');
const { deflateRawSync, inflateRawSync } = require('zlib');
const { test } = require('node:test');
const zip = require('../zip');
const { S_IFDIR, S_IFLNK, S_IFMT } = fs.constants;

// Fixed header sizes and compression methods, APPNOTE.TXT 4.3.7, 4.3.12 and 4.4.5.
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const STORED = 0;
const DEFLATED = 8;

function readEntries(zipPath) {
  const archive = fs.readFileSync(zipPath);
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(endOffset, -1, 'ZIP end record is missing');
  let offset = archive.readUInt32LE(endOffset + 16);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const entries = [];

  for (let i = 0; i < entryCount; i++) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, 'central directory entry is invalid');
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const dosTime = archive.readUInt16LE(offset + 12);
    const dosDate = archive.readUInt16LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const mode = archive.readUInt32LE(offset + 38) >>> 16;
    const localOffset = archive.readUInt32LE(offset + 42);
    const nameOffset = offset + CENTRAL_HEADER_SIZE;
    const name = archive.toString('utf8', nameOffset, nameOffset + nameLength);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + LOCAL_HEADER_SIZE + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const content = method === DEFLATED ? inflateRawSync(compressed) : compressed;

    entries.push({
      name,
      flags,
      method,
      dosTime,
      dosDate,
      extraLength,
      mode,
      compressed,
      content: content.toString(),
    });
    offset += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }

  return entries;
}

function createLink(target, linkPath, windowsType = 'file') {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? windowsType : undefined);
    return true;
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) return false;
    throw error;
  }
}

test('archives nested files without the source root and excludes build.zip', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-zip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'project');
  const nested = path.join(source, 'nested folder');
  const output = path.join(source, 'build.zip');
  const relativeTarget = path.join(source, 'plain.txt');
  const absoluteTarget = path.join(root, 'outside.txt');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(source, 'empty'));
  fs.writeFileSync(relativeTarget, 'plain body');
  fs.writeFileSync(path.join(nested, 'hello world.txt'), 'spaced body');
  fs.writeFileSync(path.join(nested, 'кириллица.txt'), 'unicode body');
  fs.writeFileSync(path.join(source, '.hidden'), 'hidden body');
  fs.writeFileSync(output, 'old archive');
  fs.writeFileSync(absoluteTarget, 'outside body');

  // Name: [target on disk, expected target in the archive].
  const links = {
    'nested folder/relative-link': ['../plain.txt', '../plain.txt'],
    'dot-link': ['./plain.txt', 'plain.txt'],
    'absolute-link': [absoluteTarget, '../outside.txt'],
  };
  const createdLinks = Object.keys(links).filter((name) =>
    createLink(links[name][0], path.join(source, name)),
  );

  await zip(source, output);

  const entries = readEntries(output);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  assert.deepEqual(
    Array.from(byName.keys()).sort(),
    [
      '.hidden',
      'empty/',
      'nested folder/',
      'nested folder/hello world.txt',
      'nested folder/кириллица.txt',
      'plain.txt',
      ...createdLinks,
    ].sort(),
  );
  assert.equal(byName.get('.hidden').content, 'hidden body');
  assert.equal(byName.get('nested folder/hello world.txt').content, 'spaced body');
  assert.equal(byName.get('nested folder/кириллица.txt').content, 'unicode body');
  assert.equal(byName.get('empty/').content, '');
  assert.equal(byName.get('empty/').method, STORED);
  // Unix permissions are kept; Windows has none, so directories get 0755 as before.
  for (const name of ['empty/', 'nested folder/']) {
    const mode =
      process.platform === 'win32' ? S_IFDIR | 0o755 : fs.statSync(path.join(source, name)).mode;
    assert.equal(byName.get(name).mode, mode, name);
  }
  assert(
    entries.every((entry) => (entry.flags & 0x800) !== 0),
    'UTF-8 flag is missing',
  );
  for (const name of createdLinks) {
    const entry = byName.get(name);
    assert.equal(entry.content, links[name][1], name);
    assert.equal(entry.method, STORED, name);
    assert.equal(entry.mode & S_IFMT, S_IFLNK, name);
  }
});

test('excludes build.zip when the source is reached through a symbolic link', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-zip-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const output = path.join(project, 'build.zip');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'index.html'), 'body');
  fs.writeFileSync(output, 'old archive');
  if (!createLink(project, path.join(project, 'source-alias'), 'junction')) {
    t.skip('symbolic links are not available');
    return;
  }

  await zip(path.join(project, 'source-alias'), output);

  const names = readEntries(output).map((entry) => entry.name);
  assert.deepEqual(names.sort(), ['index.html', 'source-alias']);
});

test('compresses files with the previous zlib level', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-zip-level-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'build.zip');
  const content = Buffer.from('repeatable text '.repeat(1024));
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'file.txt'), content);

  await zip(source, output);

  const entry = readEntries(output)[0];
  assert.equal(entry.method, DEFLATED);
  assert.deepEqual(entry.compressed, deflateRawSync(content, { level: 1 }));
});

test('writes UTC DOS timestamps without extra fields under other timezones', async (t) => {
  const localHour = (timezone) => {
    const result = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(String(new Date('2025-07-01T12:00:00Z').getHours()))"],
      { encoding: 'utf8', env: { ...process.env, TZ: timezone } },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  const berlinHour = localHour('Europe/Berlin');
  const utcHour = localHour('UTC');
  if (berlinHour !== '14' || utcHour !== '12') {
    t.skip(`Node TZ override is ineffective here (Europe/Berlin=${berlinHour}, UTC=${utcHour})`);
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-zip-time-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'build.zip');
  const mtimes = {
    'spring-gap.txt': '2025-03-30T02:30:00.000Z',
    'fall-overlap.txt': '2025-10-26T01:30:00.000Z',
    'summer.txt': '2025-07-01T12:34:57.000Z',
    'winter.txt': '2025-12-01T00:00:01.000Z',
    'before-1980.txt': '1979-12-31T23:59:58.000Z',
    'early-1980.txt': '1980-01-01T01:30:00.000Z',
  };
  fs.mkdirSync(source);
  for (const [name, mtime] of Object.entries(mtimes)) {
    const file = path.join(source, name);
    fs.writeFileSync(file, name);
    fs.utimesSync(file, new Date(mtime), new Date(mtime));
  }

  // Dates outside the DOS range are clamped.
  const expectedTimes = {
    ...mtimes,
    'before-1980.txt': '1980-01-01T00:00:00.000Z',
  };
  const script =
    'require(process.argv[1])(process.argv[2], process.argv[3]).catch((error) => { console.error(error); process.exitCode = 1; });';
  for (const timezone of ['Europe/Berlin', 'America/Los_Angeles']) {
    const child = spawnSync(
      process.execPath,
      ['-e', script, path.resolve(__dirname, '../zip'), source, output],
      {
        encoding: 'utf8',
        env: { ...process.env, TZ: timezone },
      },
    );
    assert.equal(child.status, 0, child.stderr);

    const entries = new Map(readEntries(output).map((entry) => [entry.name, entry]));
    for (const [name, mtime] of Object.entries(expectedTimes)) {
      const date = new Date(mtime);
      const entry = entries.get(name);
      const actual = [
        1980 + ((entry.dosDate >> 9) & 0x7f),
        (entry.dosDate >> 5) & 0x0f,
        entry.dosDate & 0x1f,
        (entry.dosTime >> 11) & 0x1f,
        (entry.dosTime >> 5) & 0x3f,
        (entry.dosTime & 0x1f) * 2,
      ];
      const expected = [
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        Math.floor(date.getUTCSeconds() / 2) * 2,
      ];

      assert.deepEqual(actual, expected, timezone + ' ' + name);
      assert.equal(entry.extraLength, 0, name);
    }
  }
});

test('rejects an output stream error instead of leaving an unhandled rejection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-zip-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'build.zip');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  // Enough files for the output error to arrive while the directory walk is still pending.
  for (let i = 0; i < 500; i++) {
    fs.writeFileSync(path.join(source, 'file-' + i + '.txt'), 'body');
  }

  await assert.rejects(zip(source, output), (error) =>
    ['EACCES', 'EISDIR', 'EPERM'].includes(error.code),
  );
  assert.equal(fs.statSync(output).isDirectory(), true);
});

test('rejects a directory traversal error and closes the partial output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-zip-walk-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'build.zip');
  const createWriteStream = fs.createWriteStream;
  let stream;
  t.mock.method(fs, 'createWriteStream', (...args) => (stream = createWriteStream(...args)));

  await assert.rejects(zip(path.join(root, 'missing-source'), output), { code: 'ENOENT' });
  assert.equal(stream.closed, true);
});

test(
  'rejects an output open error even if the stream never closes',
  { timeout: 5000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-zip-open-error-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'index.html'), 'body');
    // Node 14 file streams emit 'error' without 'open' or 'close' when open fails.
    t.mock.method(fs, 'createWriteStream', () => {
      const stream = new Writable({
        emitClose: false,
        write: (chunk, encoding, callback) => callback(),
      });
      process.nextTick(() =>
        stream.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' })),
      );
      return stream;
    });

    await assert.rejects(zip(source, path.join(root, 'build.zip')), { code: 'EACCES' });
  },
);

test('rejects an input read error and closes the files', { timeout: 5000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-zip-read-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  // Larger than one read, so the error comes after the file is open and partly read.
  fs.writeFileSync(path.join(source, 'large.bin'), randomBytes(1024 * 1024));
  const createReadStream = fs.createReadStream;
  const createWriteStream = fs.createWriteStream;
  let input;
  let output;
  t.mock.method(fs, 'createReadStream', (file) => {
    let reads = 0;
    const read = (fd, buffer, offset, length, position, callback) => {
      if (++reads === 2) {
        process.nextTick(callback, Object.assign(new Error('i/o error'), { code: 'EIO' }));
        return;
      }
      fs.read(fd, buffer, offset, length, position, callback);
    };
    input = createReadStream(file, { fs: { open: fs.open, read, close: fs.close } });
    return input;
  });
  t.mock.method(fs, 'createWriteStream', (...args) => (output = createWriteStream(...args)));

  await assert.rejects(zip(source, path.join(root, 'build.zip')), { code: 'EIO' });
  assert.equal(input.closed, true);
  assert.equal(output.closed, true);
});

test(
  'closes every input file before rejecting an output write error',
  { timeout: 5000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-deploy-zip-write-error-'));
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    // Incompressible and larger than the stream buffers, so the write fails mid-file.
    const size = 4 * 1024 * 1024;
    fs.writeFileSync(path.join(source, 'one.bin'), randomBytes(size));
    fs.writeFileSync(path.join(source, 'two.bin'), randomBytes(size));
    const createReadStream = fs.createReadStream;
    const createWriteStream = fs.createWriteStream;
    const inputs = [];
    let output;
    let readAtFailure;
    let reportFailure;
    const failed = new Promise((resolve) => (reportFailure = resolve));
    let releaseFirstFile;
    const firstFileReleased = new Promise((resolve) => (releaseFirstFile = resolve));
    t.mock.method(fs, 'createReadStream', (file) => {
      // The first file stays open until released: yazl starts the next file before it is closed.
      const released = inputs.length === 0 ? firstFileReleased : Promise.resolve();
      const close = (fd, callback) => released.then(() => fs.close(fd, callback));
      const stream = createReadStream(file, { fs: { open: fs.open, read: fs.read, close } });
      inputs.push(stream);
      return stream;
    });
    t.mock.method(fs, 'createWriteStream', (file) => {
      const write = (fd, buffer, offset, length, position, callback) => {
        if (inputs.length === 2 && inputs[1].bytesRead > 0) {
          readAtFailure = inputs.map((input) => input.bytesRead === size);
          process.nextTick(callback, Object.assign(new Error('no space left'), { code: 'ENOSPC' }));
          reportFailure();
          return;
        }
        fs.write(fd, buffer, offset, length, position, callback);
      };
      output = createWriteStream(file, { fs: { open: fs.open, close: fs.close, write } });
      return output;
    });
    t.after(async () => {
      releaseFirstFile();
      for (const input of inputs.filter((stream) => !stream.closed)) {
        await new Promise((resolve) => input.destroy().once('close', resolve));
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const whenClosed = (stream) =>
      new Promise((resolve) => (stream.closed ? resolve() : stream.once('close', resolve)));

    let settled = false;
    const result = zip(source, path.join(root, 'build.zip'));
    result.then(
      () => (settled = true),
      () => (settled = true),
    );
    await failed;
    // The write failed while the second file was being read.
    assert.deepEqual(readAtFailure, [true, false]);
    await Promise.all([whenClosed(output), whenClosed(inputs[1])]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'zip() settled while the first file was still open');

    releaseFirstFile();
    await assert.rejects(result, { code: 'ENOSPC' });
    assert.deepEqual(
      inputs.map((input) => input.closed),
      [true, true],
    );
  },
);
