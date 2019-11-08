const packageJson = require('./package.json');
const chalk = require('chalk');
const prompt = require('prompts');
const fetch = require('node-fetch');
const { zip } = require('zip-a-folder');
const fs = require('fs-extra');
const FormData = require('form-data');
const Configstore = require('configstore');
const vault = new Configstore(packageJson.name, {});

var configJSON = require('require-module')('./vk-hosting-config.json');
var cfg = configJSON || {};
prompt.message = "vk-mini-apps-deploy".grey;
prompt.delimiter = "=>".grey;

const API_HOST = cfg.api_host || 'https://api.vk.com/method/';
const OAUTH_HOST = cfg.oauth_host || 'https://oauth.vk.com/';

const API_VERSION = '5.101';
const DEPLOY_APP_ID = 6670517;

const CLIENT_VERSION = 2;

const APPLICATION_ENV_DEV = 1;
const APPLICATION_ENV_PRODUCTION = 2;

const CODE_SUCCESS = 200;
const CODE_DEPLOY = 201;
const CODE_SKIP = 202;
const CODE_PUSH_SENT = 203;
const CODE_PUSH_APPROVED = 204;

const TYPE_SUCCESS = 'success';

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
        message: chalk.yellow('Please open ', url)
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

async function handleQueue(user_id, base_url, key, ts, version, handled) {
  const url = base_url + '?act=a_check&key=' + key + '&ts=' + ts + '&id=' + user_id + '&wait=5';
  const query = await fetch(url);
  const res = await query.json();

  if (handled === false) {
    handled = {
      production: false,
      dev: false,
    };
  }

  if (handled.production && handled.dev) {
    return true;
  }

  if (res.events.length) {
    for (let i = 0; i < res.events.length; i++) {
      let event = res.events[i].data;
      if (event.type === 'error') {
        const message = event.message || '';
        console.error(chalk.red('Deploy failed, error code: #' + event.code + ' ' + message));
        return false;
      }

      if (event.type === TYPE_SUCCESS) {
        if (event.code === CODE_SUCCESS) {
          console.info(chalk.green('Deploy success...'));
          continue;
        }

        if (event.code === CODE_PUSH_SENT) {
          console.info(chalk.green('Please, confirm deploy on your phone.'));
          continue;
        }

        if (event.code === CODE_PUSH_APPROVED) {
          console.info(chalk.green('Deploy confirmed successfully.'));
          continue;
        }

        if (event.code === CODE_SKIP) {
          switch (event.message.environment) {
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
              console.log(urlKeys[j] + ':\t' + urls[urlKeys[j]]);
            }
          }
        }
      }
    }
  }

  return handleQueue(user_id, base_url, key, res.ts, version, handled);
}

async function getQueue(version) {
  const r = await api('apps.subscribeToHostingQueue', {app_id: cfg.app_id, version: version});
  if (!r.base_url || !r.key || !r.ts || !r.user_id) {
    throw new Error(JSON.stringify(r));
  }

  return handleQueue(r.user_id, r.base_url, r.key, r.ts, version, false);
}

async function run(cfg) {
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
      console.log(chalk.cyan('Token is saved in configstore!'));
      console.log(chalk.cyan('\nFor your CI, you can use \n > $ env MINI_APPS_ACCESS_TOKEN=' + access_token + ' yarn deploy'));
    }

    const params = {app_id: cfg.app_id, environment: environment};
    const endpointPlatformKeys = Object.keys(cfg.endpoints);
    if (endpointPlatformKeys.length) {
      for (let i = 0; i < endpointPlatformKeys.length; i++) {
        let fileName = cfg.endpoints[endpointPlatformKeys[i]];
        let filePath = './' + staticPath + '/' + fileName;
        if (!fs.existsSync(filePath)) {
          throw new Error('File ' + filePath + ' not found');
        }
        params['endpoint_' + endpointPlatformKeys[i]] = fileName;
      }
    }

    const r = await api('apps.getBundleUploadServer', params);
    if (!r.upload_url) {
      throw new Error(JSON.stringify(r));
    }

    const uploadURL = r.upload_url;
    const bundleFile = './bundle.zip';
    if (await fs.pathExists(bundleFile)) {
      fs.removeSync(bundleFile)
    }

    await zip('./' + staticPath, bundleFile);
    if (!fs.pathExists(bundleFile)) {
      console.error('Empty bundle file: ' + bundleFile);
      return false;
    }

    return await upload(uploadURL, bundleFile).then((r) => {
      if (r.version) {
        console.log('Uploaded version ' + r.version + '!');
        return getQueue(r.version);
      } else {
        console.error('Upload error:', r)
      }
    });

  } catch (e) {
    console.error(chalk.red(e));
  }
}

module.exports = {
  run: run
};
