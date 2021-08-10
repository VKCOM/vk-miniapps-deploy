const getInnerMessage = (inner) => {
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
    throw new Error(message);
  }
};

module.exports = assert;
