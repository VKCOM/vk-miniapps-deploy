'use strict';

function createProxyAgent(proxyUrl, ProxyAgent) {
  const url = new URL(proxyUrl);
  if (!url.username && !url.password) {
    return new ProxyAgent(proxyUrl);
  }

  const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  const token = 'Basic ' + Buffer.from(credentials).toString('base64');
  return new ProxyAgent({ uri: proxyUrl, token: token });
}

module.exports = createProxyAgent;
