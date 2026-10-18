'use strict';

const crypto = require('crypto');
const { styleText } = require('util');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getTraceId() {
  return crypto.randomBytes(4).toString('hex');
}

function redactAccessToken(value) {
  return String(value).replace(/([?&]access_token=)[^&#\s]*/gi, '$1<redacted>');
}

function getFetchErrorMessage(error) {
  const message = error.message || String(error);
  const cause = error.cause;
  if (!cause) {
    return redactAccessToken(message);
  }

  const causeMessage = cause.message || String(cause);
  const code = cause.code ? `${cause.code}: ` : '';
  return redactAccessToken(`${message} (${code}${causeMessage})`);
}

// Query strings may carry access_token or upload hashes
function describeUrl(url) {
  try {
    const { origin, pathname } = new URL(url);
    return origin + pathname;
  } catch {
    return '<invalid URL>';
  }
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The status is already known; a broken body adds nothing
  }
}

// Cyan is taken by the log lines, red by errors
const TRACE_ID_COLORS = ['green', 'yellow', 'blue', 'magenta'];

function colorTraceId(traceId) {
  return styleText(TRACE_ID_COLORS[parseInt(traceId, 16) % TRACE_ID_COLORS.length], traceId);
}

function createFetch(getRequestClient, debugMode) {
  return async function fetch(url, options, retries = 3, backoff = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const fetchOptions = { ...options };
        const requestClient = getRequestClient();
        if (requestClient.dispatcher) {
          fetchOptions.dispatcher = requestClient.dispatcher;
        }

        let logLine;
        if (debugMode) {
          const traceId = colorTraceId(getTraceId());
          logLine = (line, type) => console.log(`[${traceId}][${type}]`, styleText('cyan', line));

          logLine(redactAccessToken(url), 'REQ');
          options && logLine(redactAccessToken(JSON.stringify(fetchOptions)), 'REQ');
        }

        const response = await requestClient.fetch(url, fetchOptions);

        if (!response.ok) {
          // An unread body keeps the connection busy, and closing the proxy agent waits for it
          await discardBody(response);
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const body = await response.clone().text();

        if (body.trim().startsWith('<!DOCTYPE') || body.trim().startsWith('<html')) {
          throw new Error('Server returned HTML page instead of expected response');
        }

        if (logLine) {
          logLine(`${response.status} ${response.statusText}`, 'RESP');
          logLine(body, 'RESP');
        }

        return response;
      } catch (error) {
        const message = getFetchErrorMessage(error);
        const target = describeUrl(url);
        if (attempt < retries) {
          console.warn(
            styleText(
              'yellow',
              `[RETRY ${attempt}/${
                retries - 1
              }] Request to ${target} failed (${message}). Retrying in ${backoff}ms...`,
            ),
          );
          await delay(backoff);
        } else {
          console.error(
            styleText(
              'red',
              `[FETCH FAILED] Request to ${target} failed after ${retries} attempts: ${message}`,
            ),
          );
          const finalError = new Error(`Request to ${target} failed: ${message}`);
          finalError.cause = error;
          throw finalError;
        }
      }
    }
  };
}

module.exports = createFetch;
