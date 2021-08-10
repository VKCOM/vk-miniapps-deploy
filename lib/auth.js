const prompt = require('prompts');
const fetch = require('node-fetch');
const chalk = require('chalk');
const link = require('terminal-link');

const assert = require('./assert');

module.exports = async (config) => {
  if (config.noprompt) {
    throw new Error('Authorization required, but CI/CD mode is enabled');
  }

  const codeURL = config.oauth_host + 'get_auth_code?scope=offline&client_id=' + config.oauth_app;

  const authCodeResponse = await (await fetch(codeURL)).json();
  assert(authCodeResponse);

  const authCode = authCodeResponse.auth_code;
  const authCodeDevice = authCodeResponse.device_id;

  const confirmURL = config.oauth_host + 'code_auth?stage=check&code=' + authCode;
  const tokenURL = config.oauth_host + 'code_auth_token?device_id=' + authCodeDevice + '&client_id=' + config.oauth_app;

  await prompt({
    type: 'invisible',
    initial: '',
    message: chalk.yellow('Please open this', link('url', confirmURL), 'in browser'),
    onCancel: () => true
  });

  const authTokenResponse = await (await fetch(tokenURL)).json();
  assert(authTokenResponse);

  const token = authTokenResponse.access_token;
  if (!token) {
    throw new Error('User authorization failed.');
  }

  return token;
};
