var chalk = require('chalk');
var prompt = require('prompts');
const fetch = require('node-fetch');
const { zip } = require('zip-a-folder');
const fs = require('fs-extra');

var FormData = require('form-data');

var configJSON = require('require-module')('./vk-hosting-config.json');
var cfg = configJSON || {};

prompt.message = "vk-mini-apps-deploy".grey;
prompt.delimiter = "=>".grey;

const API_HOST = cfg.api_host || 'https://api.vk.com/method/';
const OAUTH_HOST = cfg.oauth_host || 'https://oauth.vk.com/';

const API_VERSION = '5.101';
const DEPLOY_APP_ID = 6670517;

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

      if (code_auth_token.status !== 200) {
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
  if (!cfg.access_token) {
    console.error('access_token is missing');
    return false;
  }

  const queryParams = Object.keys(params).map((k) => { return k + "=" + encodeURIComponent(params[k]) }).join('&');
  try {
    const query = await fetch(API_HOST + method + '?' + queryParams);
    const res = await query.json();
    if (res.error !== void 0) {
      throw new Error(JSON.stringify(res.error));
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

async function run(cfg) {
  try {
    if (!cfg.access_token) {
      const access_token = await auth();
      if (access_token) {
        cfg.access_token = access_token;
      }

      await fs.writeJson('./vk-hosting-config.json', cfg, {spaces: 2});
    }

    const r = await api('apps.getBundleUploadServer', {app_id: cfg.app_id});
    if (!r.upload_url) {
      throw new Error(JSON.stringify(r));
    }

    const uploadURL = r.upload_url;
    const bundleFile = './bundle.zip';
    if (await fs.pathExists(bundleFile)) {
      fs.removeSync(bundleFile)
    }

    await zip('./' + cfg.staticpath, bundleFile);
    if (await !fs.pathExists(bundleFile)) {
    } else {
      upload(uploadURL, bundleFile).then((r) => {
        if (r.file) {
          console.log('Uploaded!')
        } else {
          console.error('from upload:', r)
        }

      });
    }

  } catch (e) {
    console.error('err', e);
  }

}

module.exports = {
  run: run
};
