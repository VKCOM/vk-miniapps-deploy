const path = require('path');
const fs = require('fs').promises;
const access = require('fs').constants;
const fetch = require('node-fetch').default;
const stringify = require('querystring').stringify;
const { zip } = require('zip-a-folder');
const { FormData, fileFromPath } = require('formdata-node');
const { Encoder } = require('form-data-encoder');
const { Readable } = require('stream');

const assert = require('./assert');

const CLIENT_VERSION = 2;

module.exports = async (config) => {
  const params = {
    app_id: config.app_id,
    environment: config.environment,
    cli_version: CLIENT_VERSION,
    v: config.api_version,
    access_token: config.access_token
  };

  for (const endpoint in config.endpoints) {
    const fileName = config.endpoints[endpoint];
    const filePath = path.resolve(config.static_path, fileName);

    await fs.access(filePath, access.R_OK);

    params['endpoint_' + endpoint] = config.endpoints[endpoint];
  }

  const payload = await (await fetch(config.api_host + 'apps.getBundleUploadServer' + '?' + stringify(params))).json();
  assert(payload);

  const uploadURL = payload.response && payload.response.upload_url;
  if (!uploadURL) {
    throw new Error('Unfortunately, the server is temporarily unavailable. Please try again later.');
  }

  const preBundlePath = config.bundle_file || config.bundleFile;
  const bundlePath = path.resolve(process.cwd(), preBundlePath || 'build.zip');
  if (preBundlePath) {
    await fs.access(bundlePath, access.R_OK);
  } else {
    const error = await zip(config.static_path, bundlePath, { compression: 0 });
    if (error) {
      throw error;
    }
  }

  const file = await fileFromPath(bundlePath);
  const formData = new FormData();
  formData.append('file', file, {
    type: 'application/zip',
    filename: path.basename(bundlePath)
  });

  const encoder = new Encoder(formData);

  const upload = await (await fetch(uploadURL, {
    method: 'POST',
    headers: encoder.headers,
    body: Readable.from(encoder)
  })).json();
  assert(payload);

  if (!upload.version) {
    throw new Error('Unfortunately, the server is temporarily unavailable. Please try again later.');
  }

  return upload.version;
};
