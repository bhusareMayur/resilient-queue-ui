"use strict";

const { QueueRegistry, createQueueRegistry } = require("./registry");
const { handleGetMetrics } = require("./handlers/metrics");
const { handleGetDLQ } = require("./handlers/dlq");
const { handleGetJob, serializeJob } = require("./handlers/job");

/**
 * Creates the standard JSON error response envelope.
 *
 * @param {string} code Standard error code
 * @param {string} message Descriptive message
 * @param {object|null} [details=null] Optional diagnostic details
 */
function createErrorResponse(code, message, details = null) {
  return {
    error: {
      code,
      message,
      details
    }
  };
}

/**
 * Universal helper to write JSON responses across Express, Connect, or native Node http.ServerResponse.
 *
 * @param {object} res Response object
 * @param {number} status HTTP status code
 * @param {object} body JSON payload
 */
function sendJson(res, status, body) {
  if (typeof res.status === "function") {
    const chain = res.status(status);
    if (chain && typeof chain.json === "function") {
      return chain.json(body);
    }
  }

  if (typeof res.json === "function") {
    if (typeof res.status === "function") {
      res.status(status);
    } else {
      res.statusCode = status;
    }
    return res.json(body);
  }

  const jsonStr = JSON.stringify(body);
  res.statusCode = status;
  if (typeof res.setHeader === "function") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(jsonStr));
  }
  if (typeof res.end === "function") {
    res.end(jsonStr);
  }
}

/**
 * Validates and normalizes DLQ query parameters.
 *
 * @param {object} [query={}] Raw query object
 * @returns {{ start: number, limit: number, order: "asc"|"desc" } | { error: object }}
 */
function parseDLQQueryParams(query = {}) {
  let start = 0;
  let limit = 50;
  let order = "asc";

  // Validate and parse 'start'
  if (query.start !== undefined && query.start !== null && query.start !== "") {
    const rawStart = query.start;
    if (typeof rawStart === "number") {
      if (!Number.isInteger(rawStart) || rawStart < 0) {
        return {
          error: createErrorResponse(
            "VALIDATION_ERROR",
            "start must be a non-negative integer",
            { parameter: "start", value: rawStart }
          )
        };
      }
      start = rawStart;
    } else if (typeof rawStart === "string") {
      const trimmed = rawStart.trim();
      if (!/^\d+$/.test(trimmed)) {
        return {
          error: createErrorResponse(
            "VALIDATION_ERROR",
            "start must be a non-negative integer",
            { parameter: "start", value: rawStart }
          )
        };
      }
      start = parseInt(trimmed, 10);
    } else {
      return {
        error: createErrorResponse(
          "VALIDATION_ERROR",
          "start must be a non-negative integer",
          { parameter: "start", value: rawStart }
        )
      };
    }
  }

  // Validate and parse 'limit'
  if (query.limit !== undefined && query.limit !== null && query.limit !== "") {
    const rawLimit = query.limit;
    if (typeof rawLimit === "number") {
      if (!Number.isInteger(rawLimit) || rawLimit < 0) {
        return {
          error: createErrorResponse(
            "VALIDATION_ERROR",
            "limit must be a non-negative integer",
            { parameter: "limit", value: rawLimit }
          )
        };
      }
      limit = rawLimit;
    } else if (typeof rawLimit === "string") {
      const trimmed = rawLimit.trim();
      if (!/^\d+$/.test(trimmed)) {
        return {
          error: createErrorResponse(
            "VALIDATION_ERROR",
            "limit must be a non-negative integer",
            { parameter: "limit", value: rawLimit }
          )
        };
      }
      limit = parseInt(trimmed, 10);
    } else {
      return {
        error: createErrorResponse(
          "VALIDATION_ERROR",
          "limit must be a non-negative integer",
          { parameter: "limit", value: rawLimit }
        )
      };
    }
  }

  // Validate and parse 'order'
  if (query.order !== undefined && query.order !== null && query.order !== "") {
    const rawOrder = query.order;
    if (typeof rawOrder !== "string") {
      return {
        error: createErrorResponse(
          "VALIDATION_ERROR",
          'order must be "asc" or "desc"',
          { parameter: "order", value: rawOrder }
        )
      };
    }
    const normalized = rawOrder.trim().toLowerCase();
    if (normalized !== "asc" && normalized !== "desc") {
      return {
        error: createErrorResponse(
          "VALIDATION_ERROR",
          'order must be "asc" or "desc"',
          { parameter: "order", value: rawOrder }
        )
      };
    }
    order = normalized;
  }

  return { start, limit, order };
}

class DashboardDispatcher {
  constructor(options = {}) {
    this.registry =
      options instanceof QueueRegistry
        ? options
        : options?.registry instanceof QueueRegistry
        ? options.registry
        : createQueueRegistry(options);

    this.basePath = options?.basePath
      ? String(options.basePath).replace(/\/+$/, "")
      : "";
    this.localOnlyPaused = Boolean(options?.localOnlyPaused);
  }

  /**
   * Executes the GET /api/queues/:queueName/metrics route logic.
   *
   * @param {string} rawQueueName Queue identifier path parameter
   * @returns {Promise<{ status: number, body: object }>}
   */
  async executeMetricsRoute(rawQueueName) {
    if (
      rawQueueName === undefined ||
      rawQueueName === null ||
      typeof rawQueueName !== "string"
    ) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "queueName must be a non-empty string"
        )
      };
    }

    let queueName;
    try {
      queueName = decodeURIComponent(rawQueueName);
    } catch {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "Invalid URL-encoded queueName parameter"
        )
      };
    }

    const trimmedQueueName = queueName.trim();
    if (trimmedQueueName.length === 0) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "queueName must be a non-empty string"
        )
      };
    }

    const queue = this.registry.get(trimmedQueueName);
    if (!queue) {
      return {
        status: 404,
        body: createErrorResponse(
          "QUEUE_NOT_FOUND",
          `Queue '${trimmedQueueName}' is not registered with the dashboard adapter`
        )
      };
    }

    try {
      const result = await handleGetMetrics(queue, {
        localOnlyPaused: this.localOnlyPaused
      });

      return {
        status: 200,
        body: {
          queue: trimmedQueueName,
          isPaused: result.isPaused,
          metrics: result.metrics
        }
      };
    } catch (err) {
      if (
        err &&
        (err.code === "QUEUE_CLOSED" ||
          err.statusCode === 503 ||
          (typeof err.message === "string" &&
            /queue is closed/i.test(err.message)))
      ) {
        return {
          status: 503,
          body: createErrorResponse("QUEUE_CLOSED", "Queue is closed")
        };
      }

      return {
        status: 500,
        body: createErrorResponse(
          "INTERNAL_ERROR",
          err?.message || "Internal server error"
        )
      };
    }
  }

  /**
   * Executes the GET /api/queues/:queueName/dlq route logic.
   *
   * @param {string} rawQueueName Queue identifier path parameter
   * @param {object} [query={}] Query parameters (start, limit, order)
   * @returns {Promise<{ status: number, body: object }>}
   */
  async executeDLQRoute(rawQueueName, query = {}) {
    if (
      rawQueueName === undefined ||
      rawQueueName === null ||
      typeof rawQueueName !== "string"
    ) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "queueName must be a non-empty string"
        )
      };
    }

    let queueName;
    try {
      queueName = decodeURIComponent(rawQueueName);
    } catch {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "Invalid URL-encoded queueName parameter"
        )
      };
    }

    const trimmedQueueName = queueName.trim();
    if (trimmedQueueName.length === 0) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "queueName must be a non-empty string"
        )
      };
    }

    const queue = this.registry.get(trimmedQueueName);
    if (!queue) {
      return {
        status: 404,
        body: createErrorResponse(
          "QUEUE_NOT_FOUND",
          `Queue '${trimmedQueueName}' is not registered with the dashboard adapter`
        )
      };
    }

    const parsed = parseDLQQueryParams(query);
    if (parsed.error) {
      return {
        status: 400,
        body: parsed.error
      };
    }

    const { start, limit, order } = parsed;

    try {
      const result = await handleGetDLQ(queue, { start, limit, order });

      return {
        status: 200,
        body: {
          queue: trimmedQueueName,
          total: result.total,
          start,
          limit,
          order,
          jobs: result.jobs
        }
      };
    } catch (err) {
      if (
        err &&
        (err.code === "QUEUE_CLOSED" ||
          err.statusCode === 503 ||
          (typeof err.message === "string" &&
            /queue is closed/i.test(err.message)))
      ) {
        return {
          status: 503,
          body: createErrorResponse("QUEUE_CLOSED", "Queue is closed")
        };
      }

      return {
        status: 500,
        body: createErrorResponse(
          "INTERNAL_ERROR",
          err?.message || "Internal server error"
        )
      };
    }
  }

  /**
   * Executes the GET /api/queues/:queueName/jobs/:jobId route logic.
   *
   * @param {string} rawQueueName Queue identifier path parameter
   * @param {string} rawJobId Job identifier path parameter
   * @returns {Promise<{ status: number, body: object }>}
   */
  async executeJobRoute(rawQueueName, rawJobId) {
    if (
      rawQueueName === undefined ||
      rawQueueName === null ||
      typeof rawQueueName !== "string"
    ) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "queueName must be a non-empty string"
        )
      };
    }

    let queueName;
    try {
      queueName = decodeURIComponent(rawQueueName);
    } catch {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "Invalid URL-encoded queueName parameter"
        )
      };
    }

    const trimmedQueueName = queueName.trim();
    if (trimmedQueueName.length === 0) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "queueName must be a non-empty string"
        )
      };
    }

    if (
      rawJobId === undefined ||
      rawJobId === null ||
      typeof rawJobId !== "string"
    ) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "jobId must be a non-empty string"
        )
      };
    }

    let jobId;
    try {
      jobId = decodeURIComponent(rawJobId);
    } catch {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "Invalid URL-encoded jobId parameter"
        )
      };
    }

    const trimmedJobId = jobId.trim();
    if (trimmedJobId.length === 0) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "jobId must be a non-empty string"
        )
      };
    }

    const queue = this.registry.get(trimmedQueueName);
    if (!queue) {
      return {
        status: 404,
        body: createErrorResponse(
          "QUEUE_NOT_FOUND",
          `Queue '${trimmedQueueName}' is not registered with the dashboard adapter`
        )
      };
    }

    try {
      const job = await handleGetJob(queue, trimmedJobId);
      if (!job) {
        return {
          status: 404,
          body: createErrorResponse(
            "JOB_NOT_FOUND",
            `Job '${trimmedJobId}' not found or expired under retention policy`
          )
        };
      }

      return {
        status: 200,
        body: {
          queue: trimmedQueueName,
          job
        }
      };
    } catch (err) {
      if (
        err &&
        (err.code === "QUEUE_CLOSED" ||
          err.statusCode === 503 ||
          (typeof err.message === "string" &&
            /queue is closed/i.test(err.message)))
      ) {
        return {
          status: 503,
          body: createErrorResponse("QUEUE_CLOSED", "Queue is closed")
        };
      }

      return {
        status: 500,
        body: createErrorResponse(
          "INTERNAL_ERROR",
          err?.message || "Internal server error"
        )
      };
    }
  }

  /**
   * Dispatches an incoming HTTP request (Express / Connect / native Node http).
   *
   * @param {object} req
   * @param {object} res
   * @param {function} [next]
   */
  async dispatch(req, res, next) {
    let pathname = req.path || req.url || "/";
    const queryIdx = pathname.indexOf("?");
    if (queryIdx !== -1) {
      pathname = pathname.slice(0, queryIdx);
    }

    if (this.basePath) {
      if (pathname === this.basePath) {
        pathname = "/";
      } else if (pathname.startsWith(this.basePath + "/")) {
        pathname = pathname.slice(this.basePath.length);
      }
    }

    if (!pathname.startsWith("/")) {
      pathname = "/" + pathname;
    }

    const metricsMatch = pathname.match(/^\/api\/queues\/([^/]*)\/metrics\/?$/);
    const dlqMatch = pathname.match(/^\/api\/queues\/([^/]*)\/dlq\/?$/);
    const jobMatch = pathname.match(/^\/api\/queues\/([^/]*)\/jobs\/([^/]*)\/?$/);

    if (!metricsMatch && !dlqMatch && !jobMatch) {
      if (typeof next === "function") {
        return next();
      }
      return sendJson(
        res,
        404,
        createErrorResponse("ROUTE_NOT_FOUND", "Route not found")
      );
    }

    if (req.method !== "GET") {
      if (typeof next === "function") {
        return next();
      }
      return sendJson(
        res,
        405,
        createErrorResponse("METHOD_NOT_ALLOWED", "Method not allowed")
      );
    }

    try {
      if (metricsMatch) {
        const rawQueueName = metricsMatch[1];
        const result = await this.executeMetricsRoute(rawQueueName);
        return sendJson(res, result.status, result.body);
      }

      if (dlqMatch) {
        const rawQueueName = dlqMatch[1];
        let query = req.query;
        if (!query && req.url && req.url.includes("?")) {
          try {
            const parsedUrl = new URL(req.url, "http://localhost");
            query = Object.fromEntries(parsedUrl.searchParams.entries());
          } catch {
            query = {};
          }
        }
        const result = await this.executeDLQRoute(rawQueueName, query || {});
        return sendJson(res, result.status, result.body);
      }

      if (jobMatch) {
        const rawQueueName = jobMatch[1];
        const rawJobId = jobMatch[2];
        const result = await this.executeJobRoute(rawQueueName, rawJobId);
        return sendJson(res, result.status, result.body);
      }
    } catch (err) {
      sendJson(
        res,
        500,
        createErrorResponse(
          "INTERNAL_ERROR",
          err?.message || "Internal server error"
        )
      );
    }
  }
}

function createDashboardDispatcher(options) {
  return new DashboardDispatcher(options);
}

module.exports = {
  DashboardDispatcher,
  createDashboardDispatcher,
  createErrorResponse,
  parseDLQQueryParams,
  sendJson,
  serializeJob
};
