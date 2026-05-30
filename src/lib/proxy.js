import { ProxyAgent } from "undici";

const DEFAULT_PROXY = "http://127.0.0.1:7897";

let _dispatcher = null;

function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || DEFAULT_PROXY;
}

export function getDispatcher() {
  if (!_dispatcher) {
    _dispatcher = new ProxyAgent(getProxyUrl());
  }
  return _dispatcher;
}

/** 允许外部覆盖代理地址 */
export function setProxy(proxyUrl) {
  _dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null;
}
