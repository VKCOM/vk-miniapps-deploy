const fetch = require('node-fetch').default;
const stringify = require('querystring').stringify;
const prompt = require('prompts');
const chalk = require('chalk');

const assert = require('./assert');

module.exports = async (config, version) => {
  if (config.noprompt) {
    throw new Error('Authorization required, but CI/CD mode is enabled');
  }

  const result = await prompt({
    type: 'text',
    name: 'code',
    message: chalk.yellow('Please, enter code from Administration: '),
    onCancel: () => true
  });

  const params = {
    app_id: config.app_id,
    version: version,
    code: result.code,
    v: config.api_version,
    access_token: config.access_token
  };

  const payload = await (await fetch(config.api_host + 'apps.confirmDeploy' + stringify(params))).json();
  assert(payload);
};
