const DEFAULT_ENDPOINT = "http://api.ffzyapi.com/api.php/provide/vod/from/ffm3u8/at/xml/";
const DEFAULT_TIMEOUT_MS = 20_000;

export class FFZYRequestError extends Error {
  constructor(message, {
    cause,
    status = null,
    retryable = false,
    timedOut = false,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FFZYRequestError";
    this.status = status;
    this.retryable = retryable;
    this.timedOut = timedOut;
  }
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function createFFZYClient({
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("FFZY client requires fetch");
  const apiEndpoint = requiredString(endpoint, "endpoint");

  async function request(params) {
    const url = new URL(apiEndpoint);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.href, { signal: controller.signal });
      if (!response.ok) {
        throw new FFZYRequestError(`FFZY request returned HTTP ${response.status}`, {
          status: response.status,
          retryable: retryableStatus(response.status),
        });
      }
      return await response.text();
    } catch (cause) {
      if (cause instanceof FFZYRequestError) throw cause;
      const timedOut = controller.signal.aborted || cause?.name === "AbortError";
      throw new FFZYRequestError(
        timedOut ? "FFZY request timed out" : `FFZY request failed: ${cause?.message ?? cause}`,
        { cause, retryable: true, timedOut },
      );
    } finally {
      clearTimeoutImpl(timer);
    }
  }

  async function fetchCatalogXml({ categoryId, page }) {
    const normalizedCategoryId = requiredString(categoryId, "categoryId");
    if (!Number.isInteger(page) || page < 1) {
      throw new TypeError("page must be a positive integer");
    }
    return request({ ac: "list", t: normalizedCategoryId, pg: String(page) });
  }

  async function fetchDetailXml(sourceItemIds) {
    if (!Array.isArray(sourceItemIds) || sourceItemIds.length === 0) {
      throw new TypeError("source item IDs must be a non-empty array");
    }
    const ids = sourceItemIds.map((id, index) => requiredString(id, `source item IDs[${index}]`));
    return request({ ac: "detail", ids: ids.join(",") });
  }

  return Object.freeze({ fetchCatalogXml, fetchDetailXml });
}
