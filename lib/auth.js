const prompt = require('prompts');
const fetch = require('node-fetch');
const chalk = require('chalk');

module.exports = async (config) => {
  if (config.noprompt) {
    throw new Error('Authorization required, but CI/CD mode is enabled');
  }

  const codeURL = config.oauth_host + 'get_auth_code?scope=offline&client_id=' + config.oauth_app;

  const authCodeResponse = await (await fetch(codeURL)).json();

  const authCodeFail = authCodeResponse.error || authCodeResponse.response;
  if (authCodeFail) {
    throw new Error(JSON.stringify(authCodeFail));
  }

  const authCode = authCodeResponse.auth_code;
  const authCodeDevice = authCodeResponse.device_id;
  if (!authCode) {
    throw new Error('Empty auth code received');
  }

  const confirmURL = config.oauth_host + 'code_auth?stage=check&code=' + authCode;
  const tokenURL = config.oauth_host + 'code_auth_token?device_id=' + authCodeDevice + '&client_id=' + config.oauth_app;

  await prompt({
    type: 'invisible',
    initial: '',
    message: chalk.yellow('Please open this url in browser', confirmURL),
    onCancel: () => true
  });

  const authTokenResponse = await (await fetch(tokenURL)).json();

  const token = authTokenResponse.access_token;
  if (!token) {
    throw new Error('Empty access token received');
  }

  return token;
};
