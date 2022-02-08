const util = require('util');

const debug =
  typeof v8debug !== 'undefined' ||
  'DEBUG' in process.env;

const getInnerMessage = (inner) => {
  if (typeof inner === 'string') {
    return inner;
  }
  if (inner.message) {
    return inner.message;
  }
  if (inner.error_msg) {
    return inner.error_msg;
  }
  if (inner.error_message) {
    return inner.error_message;
  }
  return 'Unknown error occurred';
};

const getMessage = (payload) => {
  if (!payload) {
    return 'Unknown error occurred';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload.error) {
    return getInnerMessage(payload.error);
  }
  if (payload.response && payload.response.error) {
    return getInnerMessage(payload.response.error);
  }
  return null;
};

const assert = (payload) => {
  const message = getMessage(payload);
  if (message !== null) {
    if (debug) {
      console.log(util.inspect(payload, {
        depth: null,
        compact: false
      }));
    } else {
      Error.stackTraceLimit = -1;
    }

    throw new Error(message);
  }
};

module.exports = assert;
