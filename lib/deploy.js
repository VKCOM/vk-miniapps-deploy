const fetch = require('node-fetch').default;
const stringify = require('querystring').stringify;
const chalk = require('chalk');

const confirm = require('./confirm');

const URL_NAMES = {
  DESKTOP_DEV: 'vk_app_desktop_dev_url',
  MOBILE_DEV: 'vk_app_dev_url',
  MOBILE_WEB_DEV: 'vk_mini_app_mvk_dev_url',
  WEB_LEGACY: 'iframe_url',
  WEB: 'iframe_secure_url',
  MOBILE: 'm_iframe_secure_url',
  MOBILE_WEB: 'vk_mini_app_mvk_url'
};

const PLATFORMS = {
  WEB: 'vk.com',
  MOBILE: 'iOS & Android',
  MOBILE_WEB: 'm.vk.com'
};

const URL_NAMES_MAP = {
  [URL_NAMES.DESKTOP_DEV]: PLATFORMS.WEB,
  [URL_NAMES.MOBILE_DEV]: PLATFORMS.MOBILE,
  [URL_NAMES.MOBILE_WEB_DEV]: PLATFORMS.MOBILE_WEB,
  [URL_NAMES.WEB_LEGACY]: PLATFORMS.WEB,
  [URL_NAMES.WEB]: PLATFORMS.WEB,
  [URL_NAMES.MOBILE]: PLATFORMS.MOBILE,
  [URL_NAMES.MOBILE_WEB]: PLATFORMS.MOBILE_WEB
};

const PAD_LENGTH = 16;

const ENVIRONMENT_DEV = 1;
const ENVIRONMENT_PROD = 2;

const CODE_SUCCESS = 200;
const CODE_DEPLOY = 201;
const CODE_SKIP = 202;
const CODE_PUSH_SENT_VIA_PUSH = 203;
const CODE_PUSH_APPROVED = 204;
const CODE_CONFIRM_SENT_VIA_MESSAGE = 205;

const CI_URLS = !!process.env.CI_URLS;

const pull = async (config, version, server, state) => {
  if (state.dev && state.prod) {
    return;
  }

  const pullURL = server.base_url + '?act=a_check&key=' + server.key + '&ts=' + server.ts + '&id=' + server.app_id + '&wait=5';
  const payload = await (await fetch(pullURL)).json();

  if (payload.events) {
    for (const pulled of payload.events) {
      const event = pulled.data;

      if (event.type === 'error') {
        const message = event.message || '';
        throw new Error('Deploy failed, error code: #' + event.code + ' ' + message);
      }

      if (event.type === 'success') {
        switch (event.code) {
          case CODE_SUCCESS:
            console.info(chalk.green('Deploy success...'));
            continue;
          case CODE_PUSH_SENT_VIA_PUSH:
            console.info(chalk.green('Please, confirm deploy on your phone.'));
            continue;
          case CODE_PUSH_APPROVED:
            console.info(chalk.green('Deploy confirmed successfully.'));
            continue;

          case CODE_CONFIRM_SENT_VIA_MESSAGE:
            await confirm(config, version);
            continue;

          case CODE_SKIP:
            switch (event.message.environment) {
              case ENVIRONMENT_DEV:
                state.dev = true;
                continue;
              case ENVIRONMENT_PROD:
                state.prod = true;
                continue;
              default:
                continue;
            }

          case CODE_DEPLOY: {
            const urls = event.message && event.message.urls;
            if (urls) {
              const isProduction = event.message.is_production;

              if (isProduction && !state.prod) {
                state.prod = true;
                console.info(chalk.green('URLs changed for production:'));
              }

              if (!isProduction && !state.dev) {
                state.dev = true;
                console.info(chalk.green('URLs changed for dev:'));
              }

              for (const name in urls) {
                if (name === URL_NAMES.WEB_LEGACY) {
                  continue;
                }

                const url = urls[name];

                let prefix = URL_NAMES_MAP[name];
                if (CI_URLS) {
                  prefix = name;
                }

                prefix = prefix ? (prefix + ':').padEnd(PAD_LENGTH, ' ') : '';
                console.log(prefix + url);
              }
            }
          }
        }
      }
    }
  }

  server.ts = payload.ts;
  return pull(config, version, server, state);
};

module.exports = async (config, version) => {
  const params = {
    app_id: config.app_id,
    version: version,
    v: config.api_version,
    access_token: config.access_token
  };

  const payload = await (await fetch(config.api_host + 'apps.subscribeToHostingQueue?' + stringify(params))).json();
  const server = payload.response;
  if (payload.error || !server || !server.base_url || !server.key || !server.ts || !server.app_id) {
    throw new Error('Unfortunately, the server is temporarily unavailable. Please try again later.');
  }

  return pull(config, version, server, {
    dev: false,
    prod: false
  });
};
