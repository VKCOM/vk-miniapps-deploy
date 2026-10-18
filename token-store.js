'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const packageJson = require('./package.json');

// The configstore@5 location, so tokens saved by earlier versions keep working
const configHome =
  process.env.XDG_CONFIG_HOME ||
  (os.homedir()
    ? path.join(os.homedir(), '.config')
    : path.join(os.tmpdir(), 'vk-miniapps-deploy-' + crypto.randomBytes(8).toString('hex')));
const configPath = path.join(configHome, 'configstore', packageJson.name + '.json');

function withPermissionHint(error) {
  if (error.code === 'EACCES') {
    error.message += "\nYou don't have access to this file.\n";
  }
  return error;
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch (error) {
    // A damaged file only means a new login
    if (error.code === 'ENOENT' || error.name === 'SyntaxError') {
      return {};
    }
    throw withPermissionHint(error);
  }
}

// Writing in place keeps a symlink and the owner; a torn write leads to a new login
function save(values) {
  const contents = JSON.stringify({ ...read(), ...values }, undefined, '\t');
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    // mode applies only to a new file, so restrict an existing one first
    if (fs.existsSync(configPath)) fs.chmodSync(configPath, 0o600);
    fs.writeFileSync(configPath, contents, { mode: 0o600 });
  } catch (error) {
    throw withPermissionHint(error);
  }
}

module.exports = { read, save };
