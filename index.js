const crypto = require('crypto');
const packageJson = require('./package.json');
const chalk = require('chalk');
const prompt = require('prompts');
const nodeFetch = require('node-fetch');
const { zip } = require('zip-a-folder');
const fs = require('fs-extra');
const FormData = require('form-data');
const Configstore = require('configstore');
const vault = new Configstore(packageJson.name, {});

var configJSON = require('require-module')('./vk-hosting-config.json');
var cfg = configJSON || {};
prompt.message = "vk-mini-apps-deploy".grey;
prompt.delimiter = "=>".grey;

const DEBUG_MODE = !!cfg.debug;

const API_HOST = cfg.api_host || 'https://api.vk.com/method/';
const OAUTH_HOST = cfg.oauth_host || 'https://oauth.vk.com/';

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
  DESKTOP_DEV : 'vk_app_desktop_dev_url',
  MOBILE_DEV: 'vk_app_dev_url',
  MOBILE_WEB_DEV: 'vk_mini_app_mvk_dev_url',
  WEB_LEGACY: 'iframe_url',
  WEB: 'iframe_secure_url',
  MOBILE: 'm_iframe_secure_url',
  MOBILE_WEB: 'vk_mini_app_mvk_url',
}

const PLATFORMS = {
  WEB: 'vk.com',
  MOBILE: 'iOS & Android',
  MOBILE_WEB: 'm.vk.com',
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

function getTraceId() {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * @param {nodeFetch.RequestInfo} url 
 * @param {nodeFetch.RequestInit} options
 * @returns {Promise<nodeFetch.Response>}
 */
async function fetch(url, options) {
  if (!DEBUG_MODE) {
    return nodeFetch(url, options);
  }

  const traceId = chalk.hex(`#${(Math.random() * 0xFFFFFF << 0).toString(16)}`)(getTraceId());
  const logLine = (line, type) => console.log(`[${traceId}][${type}]`, chalk.cyan(line));
  const logError = (error) => console.error(`[${traceId}][ERROR]`, chalk.red(error));

  try {
    logLine(url, 'REQ');
    options && logLine(JSON.stringify(options), 'REQ');

    const response = await nodeFetch(url, options);
    const body = await response.clone().text();

    logLine(`${response.status} ${response.statusText}`, 'RESP');
    logLine(body, 'RESP');

    return response
  } catch (e) {
    logError(e);
    throw e;
  }
}

async function auth() {
  const get_auth_code = await fetch(OAUTH_HOST + 'get_auth_code?scope=offline&client_id=' + DEPLOY_APP_ID);
  const get_auth_code_res = await get_auth_code.json();

  if (get_auth_code_res.error !== void 0) {
    throw new Error(JSON.stringify(get_auth_code_res.error));
  }

  if (get_auth_code_res.response !== void 0) {
    console.log('fail, get_auth_code response ', get_auth_code_res);
    return get_auth_code_res.response;
  }

  if (get_auth_code_res.auth_code) {
    const {auth_code, device_id} = get_auth_code_res;

    const url = OAUTH_HOST + 'code_auth?stage=check&code=' + auth_code;

    let handled = false;
    do {
      const prompt_question = await prompt({
        type: 'confirm',
        name: 'result',
        initial: true,
        message: chalk.yellow('Please open this url in browser', url)
      });

      if (!prompt_question.result) {
        return Promise.reject("empty response " + prompt_question.result);
      }

      const code_auth_token = await fetch(OAUTH_HOST + 'code_auth_token?device_id=' + device_id + '&client_id=' + DEPLOY_APP_ID);
      const code_auth_token_json = await code_auth_token.json();

      if (code_auth_token.status !== CODE_SUCCESS) {
        console.error('code_auth_token.status: ', code_auth_token.status, code_auth_token_json);
        continue;
      }

      const {access_token} = code_auth_token_json;
      if (access_token || access_token === null) {
        handled = true;
      }

      return Promise.resolve(access_token);

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

  const queryParams = Object.keys(params).map((k) => { return k + "=" + encodeURIComponent(params[k]) }).join('&');
  try {
    const query = await fetch(API_HOST + method + '?' + queryParams);
    const res = await query.json();
    if (res.error !== void 0) {
      throw new Error(chalk.red(res.error.error_code + ': ' + res.error.error_msg));
    }

    if (res.response !== void 0) {
      return res.response;
    }
  } catch (e) {
    console.error(e);
  }
}

async function upload(uploadUrl, bundleFile) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(bundleFile), {contentType: 'application/zip'});
  try {
    const upload = await fetch(uploadUrl, {
      method: 'POST',
      headers: formData.getHeaders(),
      body: formData
    });
    return await upload.json();
  } catch (e) {
    console.error('upload error', e);
  }
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
          console.error(chalk.red('Test group url update error'));
          continue;
        }

        console.error(chalk.red('Deploy failed, error code: #' + event.code + ' ' + message));
        return false;
      }

      if (event.type === TYPE_SUCCESS) {
        if (event.code === CODE_SUCCESS) {
          console.info(chalk.green('Deploy success...'));
          continue;
        }

        if (event.code === CODE_CONFIRM_SENT_VIA_MESSAGE) {
          console.info(chalk.green('Please, confirm deploy on your phone.'));
          const result = await prompt({
            type: 'text',
            name: 'code',
            message: chalk.yellow('Please, enter code from Administration: ')
          });

          if (result.code) {
            const r = await api('apps.confirmDeploy', {
              app_id: cfg.app_id,
              version: version,
              code: result.code
            });
            if (r.error) {
              console.error('Invalid confirm code');
              return false;
            }
          }
        }

        if (event.code === CODE_PUSH_SENT_VIA_PUSH) {
          console.info(chalk.green('Please, confirm deploy on your phone.'));
          continue;
        }

        if (event.code === CODE_PUSH_APPROVED) {
          console.info(chalk.green('Deploy confirmed successfully.'));
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
              console.info(chalk.green('URLs changed for production:'));
            }

            if (!event.message.is_production && !handled.dev) {
              handled.dev = true;
              console.info(chalk.green('URLs changed for dev:'));
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
            console.info(chalk.green('URL changed for test group "' + cfg.test_group_name + '":'));
            console.info(event.message.url)
          }
        }
      }
    }
  }

  return handleQueue(user_id, base_url, key, res.ts, version, handled, cfg);
}

async function getQueue(version, cfg) {
  const r = await api('apps.subscribeToHostingQueue', {app_id: cfg.app_id, version: version});
  if (!r.base_url || !r.key || !r.ts || !r.app_id) {
    throw new Error(JSON.stringify(r));
  }

  return handleQueue(r.app_id, r.base_url, r.key, r.ts, version, false, cfg);
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
      production: APPLICATION_ENV_PRODUCTION
    };

    const environment = process.env.MINI_APPS_ENVIRONMENT
      ? (environmentMapping[process.env.MINI_APPS_ENVIRONMENT] || defaultEnvironment)
      : defaultEnvironment;

    if (process.env.MINI_APPS_ACCESS_TOKEN) {
      cfg.access_token = process.env.MINI_APPS_ACCESS_TOKEN;
    }

    if (!cfg.access_token && vault.get('access_token')) {
      cfg.access_token = vault.get('access_token');
    }

    if (!cfg.access_token) {
      console.log('Try to retrieve access token...');
      const access_token = await auth();
      cfg.access_token = access_token;
      vault.set('access_token', access_token);
      console.log(chalk.cyan('Token is saved in config store!'));
      console.log(chalk.cyan('\nFor your CI, you can use \n > $ env MINI_APPS_ACCESS_TOKEN=' + access_token + ' yarn deploy'));
    }

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

    const params = {
      app_id: cfg.app_id,
      environment: environment,
      update_prod: + cfg.update_prod,
      update_dev: + cfg.update_dev
    };

    if ('test_group_name' in cfg) {
      params.test_group_name = cfg.test_group_name
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

    const r = await api('apps.getBundleUploadServer', params);
    if (!r || !r.upload_url) {
      throw new Error(JSON.stringify('upload_url is undefined', r));
    }

    const uploadURL = r.upload_url;
    const bundleFile = cfg.bundleFile || './build.zip';

    if (!cfg.bundleFile) {
      if (await fs.pathExists(bundleFile)) {
        fs.removeSync(bundleFile)
      }


      await zip('./' + staticPath, bundleFile);
    }

    if (!fs.pathExists(bundleFile)) {
      console.error('Empty bundle file: ' + bundleFile);
      return false;
    }

    return await upload(uploadURL, bundleFile).then((r) => {
      if (r.version) {
        console.log('Uploaded version ' + r.version + '!');
        return getQueue(r.version, cfg);
      } else {
        console.error('Upload error:', r)
        process.exit(1);
      }
    });

  } catch (e) {
    console.error(chalk.red(e));
    process.exit(1);
  }
}

module.exports = {
  run: run
};
