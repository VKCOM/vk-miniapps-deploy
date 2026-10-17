'use strict';

const fs = require('fs');
const path = require('path');
const yazl = require('yazl');

// yazl reads calendar fields in local time and clamps the numeric value to local bounds.
class UtcDosDate extends Date {
  constructor(time) {
    const utc = new Date(time);
    super(
      utc.getUTCFullYear(),
      utc.getUTCMonth(),
      utc.getUTCDate(),
      utc.getUTCHours(),
      utc.getUTCMinutes(),
      utc.getUTCSeconds(),
    );
    this.utc = utc;
  }

  getFullYear() {
    return this.utc.getUTCFullYear();
  }

  getMonth() {
    return this.utc.getUTCMonth();
  }

  getDate() {
    return this.utc.getUTCDate();
  }

  getHours() {
    return this.utc.getUTCHours();
  }

  getMinutes() {
    return this.utc.getUTCMinutes();
  }

  getSeconds() {
    return this.utc.getUTCSeconds();
  }
}

const entryOptions = (stat) => ({ mtime: new UtcDosDate(stat.mtimeMs), forceDosTimestamp: true });

// Returns a function that destroys the stream and waits until its file is closed.
function trackFile(stream) {
  // Node 14 emits neither 'open' nor 'close' after a failed open.
  const opened = new Promise((resolve) => {
    stream.once('open', () => resolve(true));
    stream.once('error', () => resolve(false));
  });
  const closed = new Promise((resolve) => stream.once('close', resolve));
  return async () => {
    stream.destroy();
    if (await opened) await closed;
  };
}

// Archive links are relative and normalized like archiver: './file' and 'dir/../file' become 'file'.
async function readLinkTarget(directoryPath, linkPath) {
  const target = await fs.promises.readlink(linkPath);
  let targetPath = path.resolve(directoryPath, target);
  if (path.isAbsolute(target)) {
    // Resolve macOS /tmp aliases: directoryPath is physical.
    const targetDirectory = await fs.promises
      .realpath(path.dirname(target))
      .catch(() => path.dirname(target));
    targetPath = path.join(targetDirectory, path.basename(target));
  }
  return path.relative(directoryPath, targetPath).split(path.sep).join('/');
}

async function zip(srcFolder, zipFilePath) {
  const zipFile = new yazl.ZipFile();
  const output = fs.createWriteStream(zipFilePath);
  const closeOutput = trackFile(output);
  // yazl starts the next file before the previous one is closed.
  const inputClosers = new Set();
  let cancelled = false;
  const complete = new Promise((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    zipFile.on('error', reject);
    zipFile.outputStream.once('error', reject);
  });
  // A stream can fail while the asynchronous directory walk is pending.
  complete.catch(() => {});
  zipFile.outputStream.pipe(output);

  function orArchiveError(promise) {
    return Promise.race([promise, complete]);
  }

  try {
    // Physical paths: the output must be skipped even if the source is reached through a link.
    const sourcePath = await orArchiveError(fs.promises.realpath(srcFolder));
    const outputDirectory = await orArchiveError(fs.promises.realpath(path.dirname(zipFilePath)));
    const outputPath = path.join(outputDirectory, path.basename(zipFilePath));
    // The walk does not follow links, so every directory path stays physical.
    const directories = [{ sourcePath, archivePath: '' }];
    for (const directory of directories) {
      const names = await orArchiveError(fs.promises.readdir(directory.sourcePath));
      for (const name of names) {
        const source = path.join(directory.sourcePath, name);
        if (source === outputPath) {
          continue;
        }

        const archivePath = directory.archivePath ? directory.archivePath + '/' + name : name;
        const stat = await orArchiveError(fs.promises.lstat(source));
        if (stat.isSymbolicLink()) {
          const linkTarget = await orArchiveError(readLinkTarget(directory.sourcePath, source));
          zipFile.addBuffer(Buffer.from(linkTarget), archivePath, {
            ...entryOptions(stat),
            mode: stat.mode,
            compress: false,
          });
        } else if (stat.isDirectory()) {
          zipFile.addEmptyDirectory(archivePath + '/', {
            ...entryOptions(stat),
            mode: process.platform === 'win32' ? fs.constants.S_IFDIR | 0o755 : stat.mode,
          });
          directories.push({ sourcePath: source, archivePath });
        } else if (stat.isFile()) {
          const options = {
            ...entryOptions(stat),
            mode: stat.mode,
            compressionLevel: 1,
            size: stat.size,
          };
          // Opening the file here lets a failed archive close it.
          zipFile.addReadStreamLazy(archivePath, options, (callback) => {
            // The archive is abandoned: leave the entry pending instead of opening the file.
            if (cancelled) {
              return;
            }
            const input = fs.createReadStream(source);
            // yazl does not listen for errors of a stream it gets lazily.
            input.on('error', (error) => zipFile.emit('error', error));
            const closeInput = trackFile(input);
            inputClosers.add(closeInput);
            input.once('close', () => inputClosers.delete(closeInput));
            callback(null, input);
          });
        }
      }
    }
    zipFile.end();
    await complete;
  } catch (error) {
    cancelled = true;
    zipFile.outputStream.destroy();
    // Reject only after the file handles are released.
    await Promise.all([closeOutput(), ...Array.from(inputClosers, (closeInput) => closeInput())]);
    throw error;
  }
}

module.exports = zip;
