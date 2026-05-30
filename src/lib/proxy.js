import { ProxyAgent } from "undici";

let _dispatcher = null;
let _configuredUrl = null;

function getProxyUrl() {
  return process.env.BANGUMI_PROXY_URL || null;
}

export function getDispatcher() {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) {
    _dispatcher = null;
    _configuredUrl = null;
    return null;
  }
  if (!_dispatcher || _configuredUrl !== proxyUrl) {
    _dispatcher = new ProxyAgent(proxyUrl);
    _configuredUrl = proxyUrl;
  }
  return _dispatcher;
}

/** 允许外部覆盖代理地址 */
export function setProxy(proxyUrl) {
  if (proxyUrl) {
    process.env.BANGUMI_PROXY_URL = proxyUrl;
  } else {
    delete process.env.BANGUMI_PROXY_URL;
  }
  resetProxy();
}

export function resetProxy() {
  _dispatcher = null;
  _configuredUrl = null;
}
