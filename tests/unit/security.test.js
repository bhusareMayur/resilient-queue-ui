"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeErrorMessage,
  resolveUiAssetPath,
  sendJson,
  sendStaticFile,
  createDashboardDispatcher
} = require("../../src/dispatcher");
const { createExpressAdapter } = require("../../src/adapters/express");
const { fastifyDashboardPlugin } = require("../../src/adapters/fastify");
const OverviewView = require("../../src/ui/views/overview");
const DLQView = require("../../src/ui/views/dlq");
const JobView = require("../../src/ui/views/job");

describe("Security Audit & Protection Controls", () => {
  describe("sanitizeErrorMessage", () => {
    it("should redact embedded credentials from Redis connection URIs", () => {
      const msg1 = "Command failed at redis://:secretpass123@redis-cluster.internal:6379";
      assert.equal(
        sanitizeErrorMessage(msg1),
        "Command failed at redis://[redacted]@redis-cluster.internal:6379"
      );

      const msg2 = "Failed to connect to redis://admin:super_secret@10.0.4.12:6379/1";
      assert.equal(
        sanitizeErrorMessage(msg2),
        "Failed to connect to redis://[redacted]@10.0.4.12:6379/1"
      );

      const msg3 = "TLS Error: rediss://user:token_99@secure-redis.example.com:6380";
      assert.equal(
        sanitizeErrorMessage(msg3),
        "TLS Error: rediss://[redacted]@secure-redis.example.com:6380"
      );
    });

    it("should redact credentials from other database or HTTP connection URIs", () => {
      const msg = "HTTP ping failed at https://service-user:pass-xyz@api.internal.net/health";
      assert.equal(
        sanitizeErrorMessage(msg),
        "HTTP ping failed at https://[redacted]@api.internal.net/health"
      );
    });

    it("should redact URL-encoded credentials in connection URIs", () => {
      const msg = "Failed to connect to redis://user:p%40ssw%3Ard@redis.internal:6379/0";
      assert.equal(
        sanitizeErrorMessage(msg),
        "Failed to connect to redis://[redacted]@redis.internal:6379/0"
      );
    });

    it("should redact AUTH tokens, passwords, and secrets", () => {
      assert.equal(
        sanitizeErrorMessage("AUTH my_super_secret_redis_password failed"),
        "AUTH [redacted] failed"
      );
      assert.equal(
        sanitizeErrorMessage("Error with password: 'my_hidden_pass'"),
        "Error with password: [redacted]"
      );
      assert.equal(
        sanitizeErrorMessage("Invalid Bearer secret-jwt-token-val"),
        "Invalid Bearer [redacted]"
      );
      assert.equal(
        sanitizeErrorMessage("Config error: apikey=my-secret-key-999"),
        "Config error: apikey=[redacted]"
      );
      assert.equal(
        sanitizeErrorMessage("Config error: api_key: 'custom-secret-value'"),
        "Config error: api_key: [redacted]"
      );
    });

    it("should redact query-string tokens while preserving subsequent query parameters", () => {
      const msg = "HTTP 500 from https://api.service.internal/hook?token=supersecret123&action=retry";
      assert.equal(
        sanitizeErrorMessage(msg),
        "HTTP 500 from https://api.service.internal/hook?token=[redacted]&action=retry"
      );
    });

    it("should preserve benign diagnostic messages and words untouched", () => {
      assert.equal(sanitizeErrorMessage("Redis connection closed"), "Redis connection closed");
      assert.equal(sanitizeErrorMessage("Redis CLUSTERDOWN error"), "Redis CLUSTERDOWN error");
      assert.equal(sanitizeErrorMessage("Queue is closed"), "Queue is closed");
      assert.equal(
        sanitizeErrorMessage("Timeout awaiting command after 5000ms"),
        "Timeout awaiting command after 5000ms"
      );
      assert.equal(
        sanitizeErrorMessage("Token expired at 2026-10-19T12:00:00Z"),
        "Token expired at 2026-10-19T12:00:00Z"
      );
      assert.equal(
        sanitizeErrorMessage("Secret key missing from configuration file"),
        "Secret key missing from configuration file"
      );
      assert.equal(
        sanitizeErrorMessage("Password is incorrect for user admin"),
        "Password is incorrect for user admin"
      );
      assert.equal(
        sanitizeErrorMessage("Connection timed out for queue: emails"),
        "Connection timed out for queue: emails"
      );
    });

    it("should handle non-string, empty, or null messages safely", () => {
      assert.equal(sanitizeErrorMessage(null), "Internal server error");
      assert.equal(sanitizeErrorMessage(undefined), "Internal server error");
      assert.equal(sanitizeErrorMessage(""), "Internal server error");
      assert.equal(sanitizeErrorMessage("   "), "Internal server error");
      assert.equal(sanitizeErrorMessage(123), "Internal server error");
    });
  });

  describe("API Error Sanitization across Dispatcher Routes", () => {
    const leakyQueue = {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => {
        throw new Error("Connection failed at redis://:topsecret@redis-internal:6379");
      },
      getDLQ: async () => {
        throw new Error("DLQ scan error with password: 'leaked_db_secret'");
      },
      getJob: async () => {
        throw new Error("AUTH secret_worker_token failed");
      }
    };

    const dispatcher = createDashboardDispatcher({
      queues: { leaky: leakyQueue }
    });

    it("should sanitize error in GET /api/queues (executeQueuesRoute)", async () => {
      const res = await dispatcher.executeQueuesRoute();
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(res.body.error.message, /topsecret/);
      assert.match(res.body.error.message, /\[redacted\]/);
    });

    it("should sanitize error in GET /api/queues/:queueName/metrics (executeMetricsRoute)", async () => {
      const res = await dispatcher.executeMetricsRoute("leaky");
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(res.body.error.message, /topsecret/);
      assert.match(res.body.error.message, /\[redacted\]/);
    });

    it("should sanitize error in GET /api/queues/:queueName/dlq (executeDLQRoute)", async () => {
      const res = await dispatcher.executeDLQRoute("leaky");
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(res.body.error.message, /leaked_db_secret/);
      assert.match(res.body.error.message, /\[redacted\]/);
    });

    it("should sanitize error in GET /api/queues/:queueName/jobs/:jobId (executeJobRoute)", async () => {
      const res = await dispatcher.executeJobRoute("leaky", "job-1");
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(res.body.error.message, /secret_worker_token/);
      assert.match(res.body.error.message, /\[redacted\]/);
    });
  });

  describe("Parameter Validation & Null-Byte Rejection", () => {
    const dummyQueue = {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 0, active: 0, delayed: 0, dlq: 0 })
    };
    const dispatcher = createDashboardDispatcher({
      queues: { "safe-queue": dummyQueue }
    });

    it("should reject queueName containing null bytes in executeMetricsRoute", async () => {
      const res = await dispatcher.executeMetricsRoute("safe%00queue");
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.match(res.body.error.message, /null bytes/i);
    });

    it("should reject queueName containing null bytes in executeDLQRoute", async () => {
      const res = await dispatcher.executeDLQRoute("safe%00queue");
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.match(res.body.error.message, /null bytes/i);
    });

    it("should reject queueName containing null bytes in executeJobRoute", async () => {
      const res = await dispatcher.executeJobRoute("safe%00queue", "job-1");
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.match(res.body.error.message, /null bytes/i);
    });

    it("should reject jobId containing null bytes in executeJobRoute", async () => {
      const res = await dispatcher.executeJobRoute("safe-queue", "job%00poison");
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.match(res.body.error.message, /null bytes/i);
    });

    it("should reject malformed percent-encoding in route parameters", async () => {
      const resMetrics = await dispatcher.executeMetricsRoute("invalid%FFqueue");
      assert.equal(resMetrics.status, 400);
      assert.equal(resMetrics.body.error.code, "VALIDATION_ERROR");
      assert.match(resMetrics.body.error.message, /Invalid URL-encoded queueName/i);

      const resDLQ = await dispatcher.executeDLQRoute("invalid%FFqueue");
      assert.equal(resDLQ.status, 400);
      assert.equal(resDLQ.body.error.code, "VALIDATION_ERROR");
      assert.match(resDLQ.body.error.message, /Invalid URL-encoded queueName/i);

      const resJob = await dispatcher.executeJobRoute("safe-queue", "job%FFinvalid");
      assert.equal(resJob.status, 400);
      assert.equal(resJob.body.error.code, "VALIDATION_ERROR");
      assert.match(resJob.body.error.message, /Invalid URL-encoded jobId/i);
    });
  });

  describe("Static Asset Resolution & Path Traversal Mitigations", () => {
    it("should reject dotfile access attempts", () => {
      assert.equal(resolveUiAssetPath("/.env"), null);
      assert.equal(resolveUiAssetPath("/.git"), null);
      assert.equal(resolveUiAssetPath("/.DS_Store"), null);
      assert.equal(resolveUiAssetPath("/views/.hidden.js"), null);
      assert.equal(resolveUiAssetPath("/.htaccess"), null);
    });

    it("should reject directory backtracking and traversal attempts", () => {
      assert.equal(resolveUiAssetPath("/views/../app.js"), null);
      assert.equal(resolveUiAssetPath("/./app.js"), null);
      assert.equal(resolveUiAssetPath("/..\\package.json"), null);
      assert.equal(resolveUiAssetPath("/..\\..\\src\\index.js"), null);
    });

    it("should reject encoded traversal and null byte injections", () => {
      assert.equal(resolveUiAssetPath("/%2e%2e/package.json"), null);
      assert.equal(resolveUiAssetPath("/%2e%2e%2fpackage.json"), null);
      assert.equal(resolveUiAssetPath("/index.html\0"), null);
      assert.equal(resolveUiAssetPath("/index.html%00.js"), null);
    });

    it("should reject files with unwhitelisted extensions", () => {
      assert.equal(resolveUiAssetPath("/test.xyz"), null);
      assert.equal(resolveUiAssetPath("/malicious.exe"), null);
      assert.equal(resolveUiAssetPath("/script.sh"), null);
      assert.equal(resolveUiAssetPath("/config.yaml"), null);
    });

    it("should successfully resolve whitelisted assets with correct MIME types", () => {
      const index = resolveUiAssetPath("/");
      assert.ok(index);
      assert.equal(index.contentType, "text/html; charset=utf-8");

      const css = resolveUiAssetPath("/styles.css");
      assert.ok(css);
      assert.equal(css.contentType, "text/css; charset=utf-8");

      const js = resolveUiAssetPath("/app.js");
      assert.ok(js);
      assert.equal(js.contentType, "application/javascript; charset=utf-8");
    });
  });

  describe("HTTP Security Headers & Caching", () => {
    it("should set Cache-Control: no-store and nosniff in sendJson", () => {
      const headers = {};
      const mockRes = {
        setHeader(name, val) {
          headers[name] = val;
        },
        statusCode: 200,
        end() {}
      };

      sendJson(mockRes, 200, { ok: true });
      assert.equal(headers["Cache-Control"], "no-store");
      assert.equal(headers["X-Content-Type-Options"], "nosniff");
    });

    it("should set Cache-Control: public, max-age=300 and nosniff in sendStaticFile", () => {
      const headers = {};
      const mockRes = {
        setHeader(name, val) {
          headers[name] = val;
        },
        statusCode: 200,
        end() {}
      };

      const asset = resolveUiAssetPath("/styles.css");
      sendStaticFile(mockRes, asset.fullPath, asset.contentType);
      assert.equal(headers["Cache-Control"], "public, max-age=300");
      assert.equal(headers["X-Content-Type-Options"], "nosniff");
    });

    it("should set Cache-Control: no-store on Fastify API routes", async () => {
      const dummyQueue = {
        isClosed: false,
        isPaused: async () => false,
        getMetrics: async () => ({ waiting: 0, active: 0, delayed: 0, dlq: 0 })
      };

      const fastifyRoutes = new Map();
      const mockFastify = {
        get(path, opts, handler) {
          fastifyRoutes.set(path, handler);
        }
      };

      fastifyDashboardPlugin(mockFastify, {
        queues: { test: dummyQueue }
      });

      const handler = fastifyRoutes.get("/api/queues");
      assert.ok(handler, "Expected /api/queues route to be registered");

      const headers = {};
      let statusCode = 200;
      let sentBody = null;

      const reply = {
        header(k, v) {
          headers[k] = v;
          return reply;
        },
        code(c) {
          statusCode = c;
          return reply;
        },
        send(b) {
          sentBody = b;
          return reply;
        }
      };

      await handler({}, reply);
      assert.equal(headers["Cache-Control"], "no-store");
      assert.equal(headers["X-Content-Type-Options"], "nosniff");
      assert.equal(statusCode, 200);
      assert.ok(sentBody.queues);
    });

    it("should catch unexpected handler exceptions in Fastify and sanitize error message with security headers", async () => {
      const explodingQueue = {
        get isClosed() {
          throw new Error("Catastrophic failure with auth: Bearer super-secret-internal-token");
        }
      };

      const fastifyRoutes = new Map();
      const mockFastify = {
        get(path, opts, handler) {
          fastifyRoutes.set(path, handler);
        }
      };

      fastifyDashboardPlugin(mockFastify, {
        queues: { explode: explodingQueue }
      });

      const handler = fastifyRoutes.get("/api/queues");
      const headers = {};
      let statusCode = 200;
      let sentBody = null;

      const reply = {
        header(k, v) {
          headers[k] = v;
          return reply;
        },
        code(c) {
          statusCode = c;
          return reply;
        },
        send(b) {
          sentBody = b;
          return reply;
        }
      };

      await handler({}, reply);
      assert.equal(statusCode, 500);
      assert.equal(headers["Cache-Control"], "no-store");
      assert.equal(headers["X-Content-Type-Options"], "nosniff");
      assert.equal(sentBody.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(sentBody.error.message, /super-secret-internal-token/);
      assert.match(sentBody.error.message, /\[redacted\]/);
    });
  });

  describe("UI View Diagnostic & Error Message Sanitization", () => {
    it("OverviewView.getDiagnosticInfo should scrub credentials from description", () => {
      const leakyError = {
        code: "INTERNAL_ERROR",
        message: "Failed at redis://user:secret999@redis.prod:6379"
      };

      const diag = OverviewView.getDiagnosticInfo(leakyError);
      assert.doesNotMatch(diag.description, /secret999/);
      assert.match(diag.description, /\[redacted\]/);
      assert.doesNotMatch(diag.guidance, /secret999/);
    });

    it("DLQView.renderError should scrub credentials before rendering HTML", () => {
      const leakyError = {
        code: "INTERNAL_ERROR",
        message: "Scan failed: redis://:topsecretpass@db.local:6379"
      };

      const html = DLQView.renderError(leakyError, "orders");
      assert.doesNotMatch(html, /topsecretpass/);
      assert.match(html, /\[redacted\]/);
    });

    it("JobView.renderError should scrub credentials before rendering HTML", () => {
      const leakyError = {
        code: "INTERNAL_ERROR",
        message: "Lookup failed: AUTH secretpass_for_job failed"
      };

      const html = JobView.renderError(leakyError, "orders", "job-1");
      assert.doesNotMatch(html, /secretpass_for_job/);
      assert.match(html, /\[redacted\]/);
    });
  });

  describe("Host Application Authentication & Authorization Patterns", () => {
    it("should demonstrate Express middleware rejecting unauthenticated requests before adapter", async () => {
      const dummyQueue = {
        isClosed: false,
        isPaused: async () => false,
        getMetrics: async () => ({ waiting: 5, active: 1, delayed: 0, dlq: 0 })
      };
      const adapter = createExpressAdapter({
        queues: { emails: dummyQueue }
      });

      // Host application authentication middleware
      function hostAuthMiddleware(req, res, next) {
        const authHeader = req.headers?.authorization;
        if (authHeader !== "Bearer valid-admin-token") {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        next();
      }

      // Test 1: Unauthenticated request is rejected by hostAuthMiddleware with 401
      let status1 = null;
      let body1 = null;
      const res1 = {
        set statusCode(val) {
          status1 = val;
        },
        end(data) {
          body1 = JSON.parse(data);
        }
      };
      const req1 = {
        method: "GET",
        url: "/api/queues",
        path: "/api/queues",
        headers: {} // No token
      };

      hostAuthMiddleware(req1, res1, () => {
        adapter(req1, res1);
      });

      assert.equal(status1, 401);
      assert.equal(body1.error, "Unauthorized");

      // Test 2: Authenticated request proceeds to adapter
      let status2 = null;
      let body2 = null;
      const res2 = {
        setHeader() {},
        status(val) {
          status2 = val;
          return {
            json(data) {
              body2 = data;
            }
          };
        }
      };
      const req2 = {
        method: "GET",
        url: "/api/queues",
        path: "/api/queues",
        headers: { authorization: "Bearer valid-admin-token" }
      };

      hostAuthMiddleware(req2, res2, () => {
        adapter(req2, res2);
      });

      // Give async dispatch a turn to complete
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(status2, 200);
      assert.equal(body2.queues[0].name, "emails");
    });

    it("should demonstrate Fastify preHandler hook rejecting unauthorized requests", async () => {
      const dummyQueue = {
        isClosed: false,
        isPaused: async () => false,
        getMetrics: async () => ({ waiting: 2, active: 0, delayed: 0, dlq: 0 })
      };

      let registeredPreHandler = null;
      const mockFastify = {
        get(path, opts, handler) {
          if (opts?.preHandler) {
            registeredPreHandler = opts.preHandler;
          }
        }
      };

      // Host preHandler authentication hook
      const hostAuthHook = async (request, reply) => {
        if (request?.headers?.["x-api-key"] !== "secret-admin-key") {
          reply.code(403).send({ error: "Forbidden: Invalid API Key" });
          return false;
        }
      };

      fastifyDashboardPlugin(mockFastify, {
        queues: { billing: dummyQueue },
        preHandler: hostAuthHook
      });

      assert.equal(registeredPreHandler, hostAuthHook);

      // Verify rejection when API key is missing
      let replyCode = null;
      let replyBody = null;
      const fakeReply = {
        code(c) {
          replyCode = c;
          return fakeReply;
        },
        send(b) {
          replyBody = b;
          return fakeReply;
        }
      };

      await registeredPreHandler({ headers: {} }, fakeReply);
      assert.equal(replyCode, 403);
      assert.equal(replyBody.error, "Forbidden: Invalid API Key");
    });
  });
});
