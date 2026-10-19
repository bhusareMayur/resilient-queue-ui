"use strict";

const path = require("node:path");
const fs = require("node:fs");

const { QueueRegistry, createQueueRegistry } = require("./registry");
const { handleGetMetrics } = require("./handlers/metrics");
const { handleGetDLQ } = require("./handlers/dlq");
const { handleGetJob, serializeJob } = require("./handlers/job");
const { handleGetQueues } = require("./handlers/queues");

const UI_DIR = path.resolve(__dirname, "ui");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

/**
 * Sanitizes internal error messages before including them in API responses.
 * Redacts connection URI credentials, authentication tokens, and passwords based on known patterns,
 * preventing accidental information leakage of infrastructure details while preserving ordinary diagnostics.
 *
 * Note: Pattern-based sanitization targets known credential formats and does not guarantee
 * elimination of unknown, unstructured, or custom secret representations.
 *
 * @param {string|undefined|null} message
 * @returns {string}
 */
function sanitizeErrorMessage(message) {
  if (typeof message !== "string" || message.trim().length === 0) {
    return "Internal server error";
  }

  // 1. Redact credentials in connection URIs (e.g. redis://:pass@host:6379, redis://user:pass@host:6379, including %XX URL encoding)
  let cleaned = message.replace(
    /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?:[^:\s/@]+:)?([^@\s/]+)@/g,
    "$1[redacted]@"
  );

  // 2. Redact AUTH <secret> and Bearer <token>
  cleaned = cleaned.replace(
    /\b(AUTH|Bearer)\s+['"]?[^\s'";&]+['"]?/gi,
    "$1 [redacted]"
  );

  // 3. Redact key-value secret pairs (password=..., token:..., apikey=...)
  // Excludes '&' to preserve following query string parameters without corruption
  cleaned = cleaned.replace(
    /\b(password|passwd|pwd|token|secret|apikey|api_key)(\s*[:=]\s*)['"]?[^\s'";&]+['"]?/gi,
    "$1$2[redacted]"
  );

  return cleaned;
}

/**
 * Resolves safe absolute path to UI assets inside UI_DIR.
 * Prevents directory traversal, encoded path bypasses, and prefix collisions.
 *
 * @param {string} relPath Path requested by client
 * @returns {{ fullPath: string, contentType: string } | null}
 */
function resolveUiAssetPath(relPath) {
  if (typeof relPath !== "string") {
    return null;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) {
    return null;
  }

  // Normalize backslashes to forward slashes
  decoded = decoded.replace(/\\/g, "/");

  let clean = decoded.replace(/^\/ui\/?$/, "/index.html").replace(/^\/ui\//, "/").replace(/^\/+/, "");
  if (!clean || clean === "index.html") {
    clean = "index.html";
  }

  // Reject any segment that starts with a dot (dotfiles / hidden files / traversal)
  const segments = clean.split("/");
  if (segments.some((seg) => seg === "." || seg === ".." || seg.startsWith("."))) {
    return null;
  }

  const fullPath = path.resolve(UI_DIR, clean);
  const rel = path.relative(UI_DIR, fullPath);

  // Traversal safeguard: relative path must not start with '..' and must not be absolute
  if (rel.startsWith("..") || path.isAbsolute(rel) || fullPath === UI_DIR) {
    return null;
  }

  // Ensure resolved path is strictly within UI_DIR directory hierarchy
  if (!fullPath.startsWith(UI_DIR + path.sep)) {
    return null;
  }

  try {
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        const ext = path.extname(fullPath).toLowerCase();
        if (!MIME_TYPES[ext]) {
          return null;
        }
        return {
          fullPath,
          contentType: MIME_TYPES[ext]
        };
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Sends a static file response across Express, Connect, or native Node http.
 *
 * @param {object} res Response object
 * @param {string} filePath Path to asset
 * @param {string} contentType MIME type
 */
function sendStaticFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    if (typeof res.type === "function") {
      res.type(contentType);
    } else if (typeof res.setHeader === "function") {
      res.setHeader("Content-Type", contentType);
    }

    if (typeof res.header === "function") {
      res.header("Cache-Control", "public, max-age=300");
      res.header("X-Content-Type-Options", "nosniff");
      res.header("Content-Length", Buffer.byteLength(content));
    } else if (typeof res.setHeader === "function") {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Length", Buffer.byteLength(content));
    }

    if (typeof res.status === "function") {
      res.status(200);
    } else if (typeof res.code === "function") {
      res.code(200);
    } else {
      res.statusCode = 200;
    }

    if (typeof res.send === "function") {
      return res.send(content);
    }
    if (typeof res.end === "function") {
      return res.end(content);
    }
  } catch {
    sendJson(
      res,
      500,
      createErrorResponse("INTERNAL_ERROR", "Failed to load UI asset")
    );
  }
}

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
 * Ensures Cache-Control: no-store is applied to protect dynamic, sensitive queue telemetry.
 *
 * @param {object} res Response object
 * @param {number} status HTTP status code
 * @param {object} body JSON payload
 */
function sendJson(res, status, body) {
  if (typeof res.setHeader === "function") {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
  } else if (typeof res.header === "function") {
    res.header("Cache-Control", "no-store");
    res.header("X-Content-Type-Options", "nosniff");
  }

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
   * Executes the GET /api/queues route logic.
   *
   * @returns {Promise<{ status: number, body: object }>}
   */
  async executeQueuesRoute() {
    try {
      const result = await handleGetQueues(this.registry, {
        localOnlyPaused: this.localOnlyPaused
      });

      return {
        status: 200,
        body: result
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
          sanitizeErrorMessage(err?.message)
        )
      };
    }
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

    if (queueName.includes("\0")) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "queueName cannot contain null bytes"
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
          sanitizeErrorMessage(err?.message)
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

    if (queueName.includes("\0")) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "queueName cannot contain null bytes"
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
          sanitizeErrorMessage(err?.message)
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

    if (queueName.includes("\0")) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "queueName cannot contain null bytes"
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

    if (jobId.includes("\0")) {
      return {
        status: 400,
        body: createErrorResponse(
          "VALIDATION_ERROR",
          "jobId cannot contain null bytes"
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

      if (
        err &&
        (err.code === "NOT_SUPPORTED" ||
          err.statusCode === 501 ||
          (typeof err.message === "string" && /does not implement getJob/i.test(err.message)))
      ) {
        return {
          status: 501,
          body: createErrorResponse(
            "NOT_SUPPORTED",
            err.message || "Job inspection is not supported by this queue instance"
          )
        };
      }

      return {
        status: 500,
        body: createErrorResponse(
          "INTERNAL_ERROR",
          sanitizeErrorMessage(err?.message)
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
    let pathname = (this.basePath && req.originalUrl) ? req.originalUrl : (req.path || req.url || "/");
    const queryIdx = pathname.indexOf("?");
    if (queryIdx !== -1) {
      pathname = pathname.slice(0, queryIdx);
    }

    if (this.basePath) {
      if (pathname === this.basePath) {
        pathname = "/";
      } else if (pathname.startsWith(this.basePath + "/")) {
        pathname = pathname.slice(this.basePath.length);
      } else {
        if (typeof next === "function") {
          return next();
        }
        return sendJson(
          res,
          404,
          createErrorResponse("ROUTE_NOT_FOUND", "Route not found")
        );
      }
    }

    if (!pathname.startsWith("/")) {
      pathname = "/" + pathname;
    }

    const queuesMatch = pathname.match(/^\/api\/queues\/?$/);
    const metricsMatch = pathname.match(/^\/api\/queues\/([^/]*)\/metrics\/?$/);
    const dlqMatch = pathname.match(/^\/api\/queues\/([^/]*)\/dlq\/?$/);
    const jobMatch = pathname.match(/^\/api\/queues\/([^/]*)\/jobs\/([^/]*)\/?$/);

    const isApiRoute = Boolean(queuesMatch || metricsMatch || dlqMatch || jobMatch);

    let uiAsset = null;
    if (!isApiRoute && req.method === "GET") {
      uiAsset = resolveUiAssetPath(pathname);
    }

    if (!isApiRoute && !uiAsset) {
      if (typeof next === "function") {
        return next();
      }
      return sendJson(
        res,
        404,
        createErrorResponse("ROUTE_NOT_FOUND", "Route not found")
      );
    }

    if (uiAsset) {
      return sendStaticFile(res, uiAsset.fullPath, uiAsset.contentType);
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
      if (queuesMatch) {
        const result = await this.executeQueuesRoute();
        return sendJson(res, result.status, result.body);
      }

      if (metricsMatch) {
        const rawQueueName = metricsMatch[1];
        const result = await this.executeMetricsRoute(rawQueueName);
        return sendJson(res, result.status, result.body);
      }

      if (dlqMatch) {
        const rawQueueName = dlqMatch[1];
        let query = req.query;
        const rawUrl = req.originalUrl || req.url;
        if (!query && rawUrl && rawUrl.includes("?")) {
          try {
            const parsedUrl = new URL(rawUrl, "http://localhost");
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
          sanitizeErrorMessage(err?.message)
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
  handleGetQueues,
  parseDLQQueryParams,
  sanitizeErrorMessage,
  sendJson,
  serializeJob,
  resolveUiAssetPath,
  sendStaticFile,
  UI_DIR
};
