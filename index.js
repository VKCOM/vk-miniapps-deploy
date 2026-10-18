const path = require('path');
const { styleText } = require('util');
const fs = require('fs');
const zip = require('./zip');
const createFetch = require('./fetch-request');
const createProxyAgent = require('./proxy-agent');
const { confirm, text: promptText, close: closePrompt } = require('./readline-prompt');
const tokenStore = require('./token-store');

var configJSON = require(path.resolve(process.cwd(), './vk-hosting-config.json'));
var cfg = configJSON || {};

const DEBUG_MODE = !!cfg.debug;

const API_HOST = cfg.api_host || 'https://api.vk.ru/method/';
const OAUTH_HOST = cfg.oauth_host || 'https://oauth.vk.ru/';

const API_VERSION = '5.131';
const DEPLOY_APP_ID = 6670517;

const CLIENT_VERSION = 2;

const APPLICATION_ENV_DEV = 1;
const APPLICATION_ENV_PRODUCTION = 2;

const CODE_SUCCESS = 200;
const CODE_DEPLOY = 201;
const CODE_SKIP = 202;
const CODE_PUSH_SENT_VIA_PUSH = 203;
const CODE_PUSH_APPROVED = 204;
const CODE_CONFIRM_SENT_VIA_MESSAGE = 205;
const CODE_UPDATE_TEST_GROUP_URL = 206;

const ERROR_TEST_GROUP_UPDATE = 109;

const TYPE_SUCCESS = 'success';

const URL_NAMES = {
  DESKTOP_DEV: 'vk_app_desktop_dev_url',
  MOBILE_DEV: 'vk_app_dev_url',
  MOBILE_WEB_DEV: 'vk_mini_app_mvk_dev_url',
  WEB_LEGACY: 'iframe_url',
  WEB: 'iframe_secure_url',
  MOBILE: 'm_iframe_secure_url',
  MOBILE_WEB: 'vk_mini_app_mvk_url',
};

const PLATFORMS = {
  WEB: 'vk.ru',
  MOBILE: 'iOS & Android',
  MOBILE_WEB: 'm.vk.ru',
};

const URL_NAMES_MAP = {
  [URL_NAMES.DESKTOP_DEV]: PLATFORMS.WEB,
  [URL_NAMES.MOBILE_DEV]: PLATFORMS.MOBILE,
  [URL_NAMES.MOBILE_WEB_DEV]: PLATFORMS.MOBILE_WEB,
  [URL_NAMES.WEB_LEGACY]: PLATFORMS.WEB,
  [URL_NAMES.WEB]: PLATFORMS.WEB,
  [URL_NAMES.MOBILE]: PLATFORMS.MOBILE,
  [URL_NAMES.MOBILE_WEB]: PLATFORMS.MOBILE_WEB,
};

let proxyAgent;
let proxyFetch;
let proxyFormData;

function getRequestClient() {
  const proxy = cfg.proxy_url || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (!proxy) {
    return { fetch: globalThis.fetch, FormData: globalThis.FormData };
  }

  if (!proxyAgent) {
    const undici = require('undici');
    proxyAgent = createProxyAgent(proxy, undici.ProxyAgent);
    proxyFetch = undici.fetch;
    proxyFormData = undici.FormData;
  }

  return { fetch: proxyFetch, FormData: proxyFormData, dispatcher: proxyAgent };
}

const fetch = createFetch(getRequestClient, DEBUG_MODE);

function closeProxyAgent() {
  if (!proxyAgent) {
    return;
  }

  const agent = proxyAgent;
  proxyAgent = undefined;
  return agent.close();
}

/**
 * @param {number} app_id
 * @returns {Promise<{access_token: string, expires_in: string}>}
 */
async function auth(app_id) {
  const get_auth_code_url = `${OAUTH_HOST}get_auth_code?scope=offline&client_id=${DEPLOY_APP_ID}&mini_app_id=${app_id}`;
  const get_auth_code = await fetch(get_auth_code_url);
  const get_auth_code_res = await get_auth_code.json();

  if (get_auth_code_res.error !== void 0) {
    throw new Error(JSON.stringify(get_auth_code_res.error));
  }

  if (get_auth_code_res.response !== void 0) {
    console.log('fail, get_auth_code response ', get_auth_code_res);
    return get_auth_code_res.response;
  }

  if (get_auth_code_res.auth_code) {
    const { auth_code, device_id } = get_auth_code_res;

    const code_auth_url = `${OAUTH_HOST}code_auth?stage=check&code=${auth_code}&revoke=1`;

    let handled = false;
    do {
      const promptQuestion = await confirm(
        styleText('yellow', 'Please open this url in browser ' + code_auth_url),
        true,
      );

      if (!promptQuestion) {
        return Promise.reject('empty response ' + promptQuestion);
      }

      const code_auth_token_url = `${OAUTH_HOST}code_auth_token?device_id=${device_id}&client_id=${DEPLOY_APP_ID}&mini_app_id=${app_id}`;
      const code_auth_token = await fetch(code_auth_token_url);
      const code_auth_token_json = await code_auth_token.json();

      if (code_auth_token.status !== CODE_SUCCESS) {
        console.error('code_auth_token.status: ', code_auth_token.status, code_auth_token_json);
        continue;
      }

      const { access_token, expires_in } = code_auth_token_json;
      if (access_token || access_token === null) {
        handled = true;
      }
      return Promise.resolve({
        access_token,
        expires_in,
      });
    } while (handled === false);
  }
}

async function api(method, params) {
  params['v'] = API_VERSION;
  params['access_token'] = cfg.access_token;
  params['cli_version'] = CLIENT_VERSION;

  if (!cfg.access_token) {
    console.error('access_token is missing');
    return false;
  }

  const queryParams = Object.keys(params)
    .map((k) => {
      return k + '=' + encodeURIComponent(params[k]);
    })
    .join('&');
  const query = await fetch(API_HOST + method + '?' + queryParams);
  const res = await query.json();
  if (res.error !== void 0) {
    const errorCode = res.error.error_code;
    const errorMessage = styleText('red', errorCode + ': ' + res.error.error_msg);
    if (errorCode === 5 && !process.env.MINI_APPS_ACCESS_TOKEN && !cfg.noprompt) {
      console.error(errorMessage);

      const updateToken = await confirm(
        styleText('yellow', 'Would you like to try to retrieve a new token?'),
        true,
      );
      if (updateToken) {
        await retrieveAndSaveAccessToken(cfg);
        return api(method, params);
      } else {
        throw new Error(errorMessage);
      }
    } else {
      throw new Error(errorMessage);
    }
  }

  if (res.response !== void 0) {
    return res.response;
  }
}

async function upload(uploadUrl, bundleFile) {
  const { FormData } = getRequestClient();
  const formData = new FormData();
  const blob = await fs.openAsBlob(bundleFile, { type: 'application/zip' });
  formData.append('file', blob, path.basename(bundleFile));
  const upload = await fetch(uploadUrl, { method: 'POST', body: formData });
  return await upload.json();
}

async function handleQueue(user_id, base_url, key, ts, version, handled, cfg) {
  const url = base_url + '?act=a_check&key=' + key + '&ts=' + ts + '&id=' + user_id + '&wait=5';
  const query = await fetch(url);
  const res = await query.json();

  const ciUrls = !!process.env.CI_URLS;

  if (handled === false) {
    handled = {
      production: false,
      dev: false,
    };
  }

  if (handled.production && handled.dev) {
    return true;
  }

  if (res.events !== void 0 && res.events.length) {
    for (let i = 0; i < res.events.length; i++) {
      let event = res.events[i].data;
      if (event.type === 'error') {
        const message = event.message || '';

        if (event.code === ERROR_TEST_GROUP_UPDATE) {
          console.error(styleText('red', 'Test group url update error'));
          continue;
        }

        console.error(
          styleText('red', 'Deploy failed, error code: #' + event.code + ' ' + message),
        );
        return false;
      }

      if (event.type === TYPE_SUCCESS) {
        if (event.code === CODE_SUCCESS) {
          console.info(styleText('green', 'Deploy success...'));
          continue;
        }

        if (event.code === CODE_CONFIRM_SENT_VIA_MESSAGE) {
          console.info(styleText('green', 'Please, confirm deploy on your phone.'));
          const code = await promptText(
            styleText('yellow', 'Please, enter code from Administration:'),
          );

          if (code) {
            const r = await api('apps.confirmDeploy', {
              app_id: cfg.app_id,
              version: version,
              code: code,
            });
            if (r.error) {
              console.error('Invalid confirm code');
              return false;
            }
          }
        }

        if (event.code === CODE_PUSH_SENT_VIA_PUSH) {
          console.info(styleText('green', 'Please, confirm deploy on your phone.'));
          continue;
        }

        if (event.code === CODE_PUSH_APPROVED) {
          console.info(styleText('green', 'Deploy confirmed successfully.'));
          continue;
        }

        if (event.code === CODE_SKIP) {
          switch (parseInt(event.message.environment)) {
            case APPLICATION_ENV_DEV:
              handled.dev = true;
              break;

            case APPLICATION_ENV_PRODUCTION:
              handled.production = true;
              break;
          }
          continue;
        }

        if (event.code === CODE_DEPLOY) {
          if (event.message && event.message.urls && Object.keys(event.message.urls).length) {
            const urls = event.message.urls;
            if (event.message.is_production && !handled.production) {
              handled.production = true;
              console.info(styleText('green', 'URLs changed for production:'));
            }

            if (!event.message.is_production && !handled.dev) {
              handled.dev = true;
              console.info(styleText('green', 'URLs changed for dev:'));
            }

            let urlKeys = Object.keys(urls);
            for (let j = 0; j < urlKeys.length; j++) {
              if (urlKeys[j] === URL_NAMES.WEB_LEGACY) {
                continue;
              }

              let prefix = null;
              if (ciUrls) {
                prefix = urlKeys[j];
              } else {
                prefix = URL_NAMES_MAP[urlKeys[j]];
              }

              if (prefix) {
                prefix += ':\t';
              } else {
                prefix = '';
              }

              console.log(prefix + urls[urlKeys[j]]);
            }
          }
        }

        if (event.code === CODE_UPDATE_TEST_GROUP_URL) {
          if (event.message && event.message.url) {
            console.info(
              styleText('green', 'URL changed for test group "' + cfg.test_group_name + '":'),
            );
            console.info(event.message.url);
          }
        }
      }
    }
  }

  return handleQueue(user_id, base_url, key, res.ts, version, handled, cfg);
}

async function getQueue(version, cfg) {
  const r = await api('apps.subscribeToHostingQueue', { app_id: cfg.app_id, version: version });
  if (!r.base_url || !r.key || !r.ts || !r.app_id) {
    throw new Error(JSON.stringify(r));
  }

  return handleQueue(r.app_id, r.base_url, r.key, r.ts, version, false, cfg);
}

async function retrieveAndSaveAccessToken(cfg) {
  console.log('Try to retrieve access token...');
  const { access_token, expires_in } = await auth(cfg.app_id);
  cfg.access_token = access_token;
  tokenStore.save({ access_token, expires_in });
  console.log(styleText('cyan', 'Token is saved in config store!'));
  console.log(
    styleText(
      'cyan',
      '\nFor your CI, you can use \n > $ env MINI_APPS_ACCESS_TOKEN=' +
        access_token +
        ' yarn deploy',
    ),
  );
}

async function run(cfg) {
  if (!configJSON) {
    throw new Error('For deploy you need to create config file "vk-hosting-config.json"');
  }

  try {
    const staticPath = cfg.static_path || cfg.staticpath;
    const defaultEnvironment = APPLICATION_ENV_DEV | APPLICATION_ENV_PRODUCTION;
    const environmentMapping = {
      dev: APPLICATION_ENV_DEV,
      production: APPLICATION_ENV_PRODUCTION,
    };

    const environment = process.env.MINI_APPS_ENVIRONMENT
      ? environmentMapping[process.env.MINI_APPS_ENVIRONMENT] || defaultEnvironment
      : defaultEnvironment;

    if (process.env.MINI_APPS_APP_ID) {
      const appId = parseInt(process.env.MINI_APPS_APP_ID, 10);
      if (isNaN(appId)) {
        throw new Error('env MINI_APPS_APP_ID is not valid number');
      }
      cfg.app_id = appId;
    }

    if (!cfg.app_id) {
      throw new Error('Please provide "app_id" to vk-hosting-config.json or env MINI_APPS_APP_ID');
    }

    if (process.env.MINI_APPS_ACCESS_TOKEN) {
      cfg.access_token = process.env.MINI_APPS_ACCESS_TOKEN;
    }

    const storedToken = cfg.access_token ? {} : tokenStore.read();
    if (storedToken.access_token) {
      cfg.access_token = storedToken.access_token;
      cfg.expires_in = storedToken.expires_in || 0;
    }

    if (!cfg.access_token || (cfg.expires_in > 0 && cfg.expires_in * 1000 < Date.now())) {
      await retrieveAndSaveAccessToken(cfg);
    }

    const params = {
      app_id: cfg.app_id,
      environment: environment,
    };

    if ('test_group_name' in cfg) {
      params.test_group_name = cfg.test_group_name;
    }

    if ('update_prod' in cfg) {
      const update_prod = Number(cfg.update_prod);

      if (update_prod !== 0 && update_prod !== 1) {
        throw new Error('update_prod must be 0 or 1 or boolean.');
      }

      params.update_prod = update_prod;
    }

    if ('update_dev' in cfg) {
      const update_dev = Number(cfg.update_dev);

      if (update_dev !== 0 && update_dev !== 1) {
        throw new Error('update_dev must be 0 or 1 or boolean.');
      }

      params.update_dev = update_dev;
    }

    const endpointPlatformKeys = Object.keys(cfg.endpoints);
    if (endpointPlatformKeys.length) {
      for (let i = 0; i < endpointPlatformKeys.length; i++) {
        let endpoint = cfg.endpoints[endpointPlatformKeys[i]];
        let fileName = new URL(`/${endpoint}`, 'https://.').pathname;
        let filePath = './' + staticPath + fileName;

        if (!fs.existsSync(filePath)) {
          throw new Error('File ' + filePath + ' not found');
        }
        params['endpoint_' + endpointPlatformKeys[i]] = endpoint;
      }
    }

    const uploadServer = await api('apps.getGoHostingUploadServer', params);

    if (!uploadServer || !uploadServer.upload_url) {
      throw new Error(`upload_url is undefined: ${JSON.stringify(uploadServer)}`);
    }

    const uploadURL = uploadServer.upload_url;
    const bundleFile = cfg.bundleFile || './build.zip';

    if (!cfg.bundleFile) {
      fs.rmSync(bundleFile, { recursive: true, force: true });
      await zip('./' + staticPath, bundleFile);
    }

    if (!fs.existsSync(bundleFile)) {
      console.error('Empty bundle file: ' + bundleFile);
      return false;
    }

    const uploadResponse = await upload(uploadURL, bundleFile);
    const taskData = await api('apps.createGoHostingTask', {
      ...params,
      upload_response: Buffer.from(JSON.stringify(uploadResponse)).toString('base64'),
    });

    if (taskData.version) {
      console.log('Uploaded version ' + taskData.version + '!');
      return getQueue(taskData.version, cfg).finally(() => {
        closePrompt();
        return closeProxyAgent();
      });
    } else {
      console.error('Upload error: missing task version', taskData);
      process.exit(1);
    }
  } catch (e) {
    console.error(styleText('red', String(e)));
    process.exit(1);
  }
}

module.exports = {
  run: run,
};
