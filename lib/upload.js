const path = require('path');
const fs = require('fs').promises;
const access = require('fs').constants;
const fetch = require('node-fetch').default;
const stringify = require('querystring').stringify;
const { zip } = require('zip-a-folder');
const util = require('util');
const stream = require('fs');
const FormData = require('form-data');

const compress = util.promisify(zip);

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
  const uploadURL = payload.response && payload.response.upload_url;
  if (payload.error || !uploadURL) {
    throw new Error('Unfortunately, the server is temporarily unavailable. Please try again later.');
  }

  const preBundlePath = config.bundle_file || config.bundleFile;
  const bundlePath = path.resolve(process.cwd(), preBundlePath || 'build.zip');
  if (preBundlePath) {
    await fs.access(bundlePath, access.R_OK);
  } else {
    await compress(config.static_path, bundlePath);
  }

  const formData = new FormData();
  formData.append('file', stream.createReadStream(bundlePath), { contentType: 'application/zip' });
  const upload = await (await fetch(uploadURL, {
    method: 'POST',
    headers: formData.getHeaders(),
    body: formData
  })).json();
  if (!upload.version) {
    throw new Error('Unfortunately, the server is temporarily unavailable. Please try again later.');
  }

  return upload.version;
};
