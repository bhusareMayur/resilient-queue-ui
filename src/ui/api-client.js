"use strict";

/**
 * Custom error class for API errors returned by resilient-queue-ui endpoints or network issues.
 */
class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = typeof options.status === "number" ? options.status : 0;
    this.code = options.code || "UNKNOWN_ERROR";
    this.details = options.details !== undefined ? options.details : null;
    this.rawResponse = options.rawResponse !== undefined ? options.rawResponse : null;
  }
}

/**
 * Frontend API client for interacting with @mayurbhusare/resilient-queue-ui REST endpoints.
 * Conforms strictly to docs/api-contract.md.
 */
class ApiClient {
  /**
   * @param {object|string} [options={}] Configuration options or baseUrl string
   * @param {string} [options.baseUrl=""] Base URL for API calls (e.g. "/admin/queues" or "http://localhost:3000")
   * @param {typeof fetch} [options.fetch] Custom fetch implementation (defaults to globalThis.fetch)
   */
  constructor(options = {}) {
    const config = typeof options === "string" ? { baseUrl: options } : options || {};
    this.baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
    this.fetch = config.fetch || (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
  }

  /**
   * Constructs an absolute or relative URL with encoded path segments and query parameters.
   *
   * @param {string} path API path starting with "/"
   * @param {Record<string, any>} [query={}] Optional query parameter dictionary
   * @returns {string} Fully resolved URL string
   */
  buildUrl(path, query = {}) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const urlStr = `${this.baseUrl}${normalizedPath}`;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        params.append(key, String(value));
      }
    }
    const queryString = params.toString();
    return queryString ? `${urlStr}?${queryString}` : urlStr;
  }

  /**
   * Executes an HTTP GET request and normalizes responses or errors.
   *
   * @private
   * @param {string} url
   * @returns {Promise<any>}
   */
  async _request(url) {
    if (typeof this.fetch !== "function") {
      throw new ApiError("No fetch implementation available in the current environment", {
        code: "ENVIRONMENT_ERROR",
        status: 0
      });
    }

    let response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      });
    } catch (networkErr) {
      throw new ApiError(networkErr?.message || "Network request failed", {
        code: "NETWORK_ERROR",
        status: 0,
        details: networkErr
      });
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (parseErr) {
      if (!response.ok) {
        throw new ApiError(`HTTP error ${response.status}`, {
          code: "HTTP_ERROR",
          status: response.status,
          rawResponse: text
        });
      }
      throw new ApiError("Invalid JSON response from server", {
        code: "PARSE_ERROR",
        status: response.status,
        rawResponse: text,
        details: parseErr
      });
    }

    if (!response.ok) {
      const errorCode = data?.error?.code || "HTTP_ERROR";
      const errorMessage = data?.error?.message || `HTTP error ${response.status}`;
      const errorDetails = data?.error?.details !== undefined ? data.error.details : null;

      throw new ApiError(errorMessage, {
        code: errorCode,
        status: response.status,
        details: errorDetails,
        rawResponse: data
      });
    }

    return data;
  }

  /**
   * GET /api/queues
   * Retrieves summary and metrics for all explicitly registered queues.
   *
   * @returns {Promise<{ queues: Array<{ name: string, isPaused: boolean, metrics: { waiting: number, active: number, delayed: number, dlq: number } }> }>}
   */
  async getQueues() {
    const url = this.buildUrl("/api/queues");
    return this._request(url);
  }

  /**
   * GET /api/queues/:queueName/metrics
   * Retrieves instantaneous metrics and pause status for a single registered queue.
   *
   * @param {string} queueName
   * @returns {Promise<{ queue: string, isPaused: boolean, metrics: { waiting: number, active: number, delayed: number, dlq: number } }>}
   */
  async getQueueMetrics(queueName) {
    const normalizedQueueName = queueName !== undefined && queueName !== null ? String(queueName).trim() : "";
    if (normalizedQueueName.length === 0) {
      throw new ApiError("queueName must be a non-empty string", {
        code: "VALIDATION_ERROR",
        status: 400
      });
    }

    const encodedName = encodeURIComponent(normalizedQueueName);
    const url = this.buildUrl(`/api/queues/${encodedName}/metrics`);
    return this._request(url);
  }

  /**
   * GET /api/queues/:queueName/dlq
   * Retrieves paginated DLQ jobs for a registered queue.
   *
   * @param {string} queueName
   * @param {object} [query={}]
   * @param {number} [query.start]
   * @param {number} [query.limit]
   * @param {"asc"|"desc"} [query.order]
   * @returns {Promise<{ queue: string, total: number, start: number, limit: number, order: string, jobs: Array<object> }>}
   */
  async getQueueDLQ(queueName, query = {}) {
    const normalizedQueueName = queueName !== undefined && queueName !== null ? String(queueName).trim() : "";
    if (normalizedQueueName.length === 0) {
      throw new ApiError("queueName must be a non-empty string", {
        code: "VALIDATION_ERROR",
        status: 400
      });
    }

    const encodedName = encodeURIComponent(normalizedQueueName);
    const queryParams = {};
    if (query.start !== undefined && query.start !== null) queryParams.start = query.start;
    if (query.limit !== undefined && query.limit !== null) queryParams.limit = query.limit;
    if (query.order !== undefined && query.order !== null) queryParams.order = query.order;

    const url = this.buildUrl(`/api/queues/${encodedName}/dlq`, queryParams);
    return this._request(url);
  }

  /**
   * GET /api/queues/:queueName/jobs/:jobId
   * Retrieves single job descriptor by unique job ID.
   *
   * @param {string} queueName
   * @param {string|number} jobId
   * @returns {Promise<{ queue: string, job: object }>}
   */
  async getJob(queueName, jobId) {
    const normalizedQueueName = queueName !== undefined && queueName !== null ? String(queueName).trim() : "";
    if (normalizedQueueName.length === 0) {
      throw new ApiError("queueName must be a non-empty string", {
        code: "VALIDATION_ERROR",
        status: 400
      });
    }

    const normalizedJobId = jobId !== undefined && jobId !== null ? String(jobId).trim() : "";
    if (normalizedJobId.length === 0) {
      throw new ApiError("jobId must be a non-empty string", {
        code: "VALIDATION_ERROR",
        status: 400
      });
    }

    const encodedName = encodeURIComponent(normalizedQueueName);
    const encodedJobId = encodeURIComponent(normalizedJobId);
    const url = this.buildUrl(`/api/queues/${encodedName}/jobs/${encodedJobId}`);
    return this._request(url);
  }
}

// Universal module definition supporting Node.js (CommonJS) and browser globals
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ApiClient,
    ApiError
  };
}

if (typeof globalThis !== "undefined") {
  globalThis.ResilientQueueApiClient = {
    ApiClient,
    ApiError
  };
}
