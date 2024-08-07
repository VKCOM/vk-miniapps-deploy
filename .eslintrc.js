module.exports = {
  extends: ['plugin:@vkontakte/eslint-plugin/default', 'prettier'],
  parserOptions: {
    requireConfigFile: false,
  },
  rules: {
    'import/no-duplicates': 'off',
    'no-undef': 'off',
    'no-shadow': 'off',
    'no-var': 'off',
    'camelcase': 'off',
    'valid-jsdoc': 'off',
  },
};
