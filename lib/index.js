const path = require('path');
const fs = require('fs').promises;
const access = require('fs').constants;
const chalk = require('chalk');
const link = require('terminal-link');
const isCI = require('is-ci');
const Configstore = require('configstore');
const prompt = require('prompts');

const pkg = require('../package.json');

const auth = require('./auth');
const upload = require('./upload');
const deploy = require('./deploy');

const ENVIRONMENT_DEV = 1;
const ENVIRONMENT_PROD = 2;
const ENVIRONMENTS = {
  dev: ENVIRONMENT_DEV,
  development: ENVIRONMENT_DEV,

  prod: ENVIRONMENT_PROD,
  production: ENVIRONMENT_PROD
};

const DEFAULTS = {
  app_id: 0,

  api_host: 'https://api.vk.com/method/',
  api_version: '5.131',

  oauth_host: 'https://oauth.vk.com/',
  oauth_app: 6670517,

  noprompt: false,
  access_token: '',

  environment: ENVIRONMENT_DEV | ENVIRONMENT_PROD
};

(async () => {
  let vault;

  try {
    // config
    const configPath = path.resolve(process.cwd(), 'vk-hosting-config.json');
    await fs.access(configPath, access.R_OK);
    const config = Object.assign(DEFAULTS, require(configPath));

    // CI
    process.env.CI = config.noprompt || isCI || process.env.CI === '1' || process.env.CI === 'true' || !process.stdout.isTTY;
    config.noprompt = process.env.CI === 'true';

    // vault
    vault = config.noprompt ? new Map() : new Configstore(pkg.name, {});

    // files
    config.static_path = process.env.MINI_APPS_PATH || config.static_path || config.staticpath || 'dist';
    config.static_path = path.resolve(process.cwd(), config.static_path);
    await fs.access(config.static_path, access.R_OK);

    // app_id
    config.app_id = process.env.MINI_APPS_APP_ID || config.app_id;
    if (!config.app_id) {
      throw new Error('Please provide "app_id" to vk-hosting-config.json or env MINI_APPS_APP_ID');
    }

    // environment
    config.environment = process.env.MINI_APPS_ENVIRONMENT &&
      ENVIRONMENTS[process.env.MINI_APPS_ENVIRONMENT] || config.environment;

    // access_token
    config.access_token = process.env.MINI_APPS_ACCESS_TOKEN || vault.get('access_token');
    if (!config.access_token) {
      console.log('Try to retrieve access token...');
      config.access_token = await auth(config);
    }
    if (!config.noprompt) {
      const saved = vault.get('access_token');
      vault.set('access_token', config.access_token);
      if (!saved) {
        console.log(chalk.cyan('Token is saved in config store!'));
        console.log(chalk.cyan('\nFor your CI, you can use \n > $ cross-env MINI_APPS_ACCESS_TOKEN=' + config.access_token + ' yarn deploy'));
      }
    }

    if (!config.noprompt) {
      const result = await prompt({
        type: 'confirm',
        initial: true,
        name: 'confirm',
        message: chalk.yellow('Would you like to deploy to VK Mini Apps hosting using these commands?')
      });

      if (!result.confirm) {
        return;
      }
    }

    const version = await upload(config);
    console.log('Uploaded version ' + version + '!');

    await deploy(config, version);
  } catch (e) {
    if (e && e.syscall === 'access') {
      const file = path.basename(e.path);
      console.error(chalk.red(file + ' is missing or unreadable'));
    } else {
      const message = e && e.message || 'Unknown error occurred';
      if (message.includes('authorization')) {
        console.error(chalk.red('Access token is invalid.'));
        if (vault) {
          vault.delete('access_token');
        }
      }
      console.error(chalk.red(message));
      console.log('Try to run again or see', link('troubleshooting', 'https://github.com/vkcom/vk-miniapps-deploy#troubleshooting', {
        fallback: (_, url) => url
      }), 'if problem recurs.');
    }
    process.exit(1);
  }
})();
