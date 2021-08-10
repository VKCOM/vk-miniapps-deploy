[<img width="134" src="https://vk.com/images/apps/mini_apps/vk_mini_apps_logo.svg">](https://vk.com/services)

# VK Mini Apps Deploy [![npm][npm]][npm-url] [![deps][deps]][deps-url]

Deploy straight to VK Mini Apps hosting with one simple command.

## Usage

```
# install it from npm and symlink it into your PATH
npm install @vkontakte/vk-miniapps-deploy -g

# now run it!
vk-miniapps-deploy
```

You can also use `npm run` to package it with your app without installing it globally.

First add this to your scripts section of `package.json`:

```JSON
  "scripts": {
    "deploy": "vk-miniapps-deploy",
    "clean-source": "rimraf README.md src webroot package.json"
  },
```

And then install `vk-miniapps-deploy` as a devDependency:

```
npm install @vkontakte/vk-miniapps-deploy --save-dev
```

And now you can run `npm run deploy` to run the `vk-miniapps-deploy` installed in the local `node_modules` folder (even if you have never done `npm install vk-miniapps-deploy -g`).

## Options

To configure `vk-miniapps-deploy` all you need to do is specify a couple of things in your `vk-hosting-config.json` 

``` JSON
{
  "static_path": "build",
  "app_id": "...",
  "endpoints": {
    "mobile": "index.html",
    "mvk": "index.html",
    "web": "index.html"
  }
}
```

## How to use:
* Make sure that in package.json the key value «homepage» is «./»
* Copy the example config to the root folder of your application vk-hosting-config.json.example
  and remove the suffix «.example»
* Run yarn deploy

CI/CD is automatically detected, you only need to pass `access_token` to env or define in config:

```bash
$ cross-env MINI_APPS_ACCESS_TOKEN=<token> yarn deploy
```
or
```json
{
  "access_token": "<token>"
}
```

with *user token* retrieved from vk-miniapps-deploy OR *service token* of deployable application

There are two values to specify MINI_APPS_ENVIRONMENT: `production` or `dev`. 
All production builds will be also deployed on dev environment.

If you grep URL paths, you can use environment variable `CI_URLS = true`.

If you always need to run in CI/CD-mode, in config:
```json
{
  "noprompt": true
}
```

## Troubleshooting:
If you get an error `User authorization failed: invalid session`, try this comand:
```bash
rm ~/.config/configstore/@vkontakte/vk-miniapps-deploy.json
```
[npm]: https://img.shields.io/npm/v/@vkontakte/vk-miniapps-deploy.svg
[npm-url]: https://npmjs.com/package/@vkontakte/vk-miniapps-deploy
[deps]: https://img.shields.io/david/vkcom/vk-miniapps-deploy.svg
[deps-url]: https://david-dm.org/vkcom/vk-miniapps-deploy
