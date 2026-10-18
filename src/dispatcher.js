"use strict";

const { QueueRegistry, createQueueRegistry } = require("./registry");
const { handleGetMetrics } = require("./handlers/metrics");

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

    const match = pathname.match(/^\/api\/queues\/([^/]*)\/metrics\/?$/);
    if (!match) {
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

    const rawQueueName = match[1];
    try {
      const result = await this.executeMetricsRoute(rawQueueName);
      sendJson(res, result.status, result.body);
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
  sendJson
};
