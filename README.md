[<img width="134" src="https://sun9-30.userapi.com/IMLu3sXowImUG-VtL34AqHT4qIUBapkCO0dyhA/bz55lWspvOk.svg">](https://vk.com/services)

# VK Mini Apps Deploy [![npm][npm]][npm-url]

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

```JSON
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

- Make sure that in package.json the key value «homepage» is «./»
- Copy the example config to the root folder of your application vk-hosting-config.json.example
  and remove the suffix «.example»
- Run yarn deploy

For your CI, you can use

```bash
$ env MINI_APPS_ACCESS_TOKEN=<token> yarn deploy
```

with _user token_ retrieved from vk-miniapps-deploy OR _service token_ of deployable application

There are two values to specify MINI_APPS_ENVIRONMENT: `production` or `dev`.
All production builds will be also deployed on dev environment.

If you grep URL paths, you can use environment variable `CI_URLS = true`.

## Troubleshooting:

If you get an error `User authorization failed: invalid session`, try this comand:

```bash
rm ~/.config/configstore/@vkontakte/vk-miniapps-deploy.json
```

[npm]: https://img.shields.io/npm/v/@vkontakte/vk-miniapps-deploy.svg
[npm-url]: https://npmjs.com/package/@vkontakte/vk-miniapps-deploy
