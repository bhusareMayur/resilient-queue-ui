"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createExpressAdapter, fastifyDashboardPlugin } = require("../../src/index");
const { requireAuthentication, authorizeQueueAccess, applySecurityHeaders } = require("../../examples/express-auth");
const { fastifyAuthHook } = require("../../examples/fastify-auth");

describe("Framework Adapters & Security E2E Integration", () => {
  let expressServerDefault;
  let expressUrlDefault;
  let expressServerPrefixed;
  let expressUrlPrefixed;
  let closedQueueState = false;

  const mockQueues = {
    "mail-queue": {
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 12, active: 3, delayed: 1, dlq: 2 }),
      getDLQ: async ({ start = 0, limit = 50, order = "desc" } = {}) => ({
        total: 2,
        jobs: [
          {
            id: "job-bad-1",
            data: { to: "attacker<script>alert(1)</script>@example.com" },
            attempt: 3,
            stalledCount: 0,
            createdAt: 1770000000000,
            failedAt: 1770000050000,
            failureReason: "SMTP Error: <script>alert('xss')</script>"
          },
          {
            id: null,
            corrupted: true,
            raw: "unparsed_raw_entry",
            error: "SyntaxError: Unexpected token u"
          }
        ]
      }),
      getJob: async (jobId) => {
        if (jobId === "job-safe-1") {
          return {
            id: "job-safe-1",
            state: "completed",
            progress: 100,
            data: { safe: true, payload: "<img src=x onerror=alert(1)>" },
            returnValue: { ok: true },
            updateProgress: async () => {} // must be stripped by serializer
          };
        }
        return null;
      }
    },
    "closed-queue": {
      get isClosed() {
        return closedQueueState;
      },
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 0, active: 0, delayed: 0, dlq: 0 }),
      getDLQ: async () => ({ total: 0, jobs: [] }),
      getJob: async () => null
    },
    "legacy-v202-queue": {
      // Simulates @mayurbhusare/resilient-queue@2.0.2 lacking getJob
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 0, active: 0, delayed: 0, dlq: 0 }),
      getDLQ: async () => ({ total: 0, jobs: [] })
    },
    "special/queue name#1": {
      // Tests URL encoded characters and safe handling
      isClosed: false,
      isPaused: async () => false,
      getMetrics: async () => ({ waiting: 1, active: 0, delayed: 0, dlq: 0 }),
      getDLQ: async () => ({ total: 0, jobs: [] })
    }
  };

  before(async () => {
    // 1. Express server at default prefix ("/")
    const adapterDefault = createExpressAdapter({
      queues: mockQueues
    });
    expressServerDefault = http.createServer((req, res) => {
      adapterDefault(req, res, (err) => {
        if (err) {
          res.statusCode = 500;
          return res.end(JSON.stringify({ error: err.message }));
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "Handled by downstream next()" }));
      });
    });
    await new Promise((resolve) => {
      expressServerDefault.listen(0, "127.0.0.1", () => {
        expressUrlDefault = `http://127.0.0.1:${expressServerDefault.address().port}`;
        resolve();
      });
    });

    // 2. Express server with custom basePath prefix ("/admin/queues")
    const adapterPrefixed = createExpressAdapter({
      basePath: "/admin/queues",
      queues: mockQueues
    });
    expressServerPrefixed = http.createServer((req, res) => {
      adapterPrefixed(req, res, (err) => {
        if (err) {
          res.statusCode = 500;
          return res.end(JSON.stringify({ error: err.message }));
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "Handled by downstream next()" }));
      });
    });
    await new Promise((resolve) => {
      expressServerPrefixed.listen(0, "127.0.0.1", () => {
        expressUrlPrefixed = `http://127.0.0.1:${expressServerPrefixed.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (expressServerDefault) {
      await new Promise((resolve) => expressServerDefault.close(resolve));
    }
    if (expressServerPrefixed) {
      await new Promise((resolve) => expressServerPrefixed.close(resolve));
    }
  });

  describe("Express Adapter E2E Verification", () => {
    it("should mount dashboard assets and API endpoints at default prefix", async () => {
      // 1. Assets
      const resHtml = await fetch(`${expressUrlDefault}/`);
      assert.equal(resHtml.status, 200);
      assert.match(resHtml.headers.get("content-type"), /text\/html/);

      const resCss = await fetch(`${expressUrlDefault}/styles.css`);
      assert.equal(resCss.status, 200);
      assert.match(resCss.headers.get("content-type"), /text\/css/);

      const resAppJs = await fetch(`${expressUrlDefault}/app.js`);
      assert.equal(resAppJs.status, 200);
      assert.match(resAppJs.headers.get("content-type"), /application\/javascript/);

      // 2. API Queues
      const resApiQueues = await fetch(`${expressUrlDefault}/api/queues`);
      assert.equal(resApiQueues.status, 200);
      const dataQueues = await resApiQueues.json();
      assert.ok(Array.isArray(dataQueues.queues));
      assert.equal(dataQueues.queues.length, 4);

      // 3. API Metrics
      const resMetrics = await fetch(`${expressUrlDefault}/api/queues/mail-queue/metrics`);
      assert.equal(resMetrics.status, 200);
      const dataMetrics = await resMetrics.json();
      assert.equal(dataMetrics.metrics.waiting, 12);
    });

    it("should mount dashboard assets and API endpoints under custom basePath prefix", async () => {
      // 1. Assets under prefix
      const resHtml = await fetch(`${expressUrlPrefixed}/admin/queues`);
      assert.equal(resHtml.status, 200);
      assert.match(resHtml.headers.get("content-type"), /text\/html/);

      const resCss = await fetch(`${expressUrlPrefixed}/admin/queues/styles.css`);
      assert.equal(resCss.status, 200);

      // 2. API endpoints under prefix
      const resApi = await fetch(`${expressUrlPrefixed}/admin/queues/api/queues`);
      assert.equal(resApi.status, 200);

      // 3. Fall through to next() for requests outside prefix
      const resOutside = await fetch(`${expressUrlPrefixed}/api/queues`);
      assert.equal(resOutside.status, 404);
      const dataOutside = await resOutside.json();
      assert.equal(dataOutside.message, "Handled by downstream next()");
    });

    it("should enforce mandatory explicit queue registration", async () => {
      const res = await fetch(`${expressUrlDefault}/api/queues/non-registered-queue/metrics`);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.error.code, "QUEUE_NOT_FOUND");
      assert.match(data.error.message, /not registered/);
    });

    it("should return 503 QUEUE_CLOSED when accessing a closed queue", async () => {
      closedQueueState = true;
      try {
        const resMetrics = await fetch(`${expressUrlDefault}/api/queues/closed-queue/metrics`);
        assert.equal(resMetrics.status, 503);
        const dataMetrics = await resMetrics.json();
        assert.equal(dataMetrics.error.code, "QUEUE_CLOSED");

        const resDLQ = await fetch(`${expressUrlDefault}/api/queues/closed-queue/dlq`);
        assert.equal(resDLQ.status, 503);
        const dataDLQ = await resDLQ.json();
        assert.equal(dataDLQ.error.code, "QUEUE_CLOSED");
      } finally {
        closedQueueState = false;
      }
    });

    it("should return 501 NOT_SUPPORTED for core v2.0.2 compatibility when getJob() is missing", async () => {
      const res = await fetch(`${expressUrlDefault}/api/queues/legacy-v202-queue/jobs/any-job-id`);
      assert.equal(res.status, 501);
      const data = await res.json();
      assert.equal(data.error.code, "NOT_SUPPORTED");
      assert.match(data.error.message, /getJob/);
    });

    it("should serialize job and omit functions like updateProgress", async () => {
      const res = await fetch(`${expressUrlDefault}/api/queues/mail-queue/jobs/job-safe-1`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.job.id, "job-safe-1");
      assert.equal(data.job.state, "completed");
      assert.equal(data.job.progress, 100);
      assert.equal("updateProgress" in data.job, false);
    });

    it("should enforce read-only behavior and fall through for non-GET HTTP methods", async () => {
      // POST
      const resPost = await fetch(`${expressUrlDefault}/api/queues`, { method: "POST" });
      assert.equal(resPost.status, 404);
      const dataPost = await resPost.json();
      assert.equal(dataPost.message, "Handled by downstream next()");

      // DELETE
      const resDelete = await fetch(`${expressUrlDefault}/api/queues/mail-queue/dlq`, { method: "DELETE" });
      assert.equal(resDelete.status, 404);

      // PUT
      const resPut = await fetch(`${expressUrlDefault}/api/queues/mail-queue/metrics`, { method: "PUT" });
      assert.equal(resPut.status, 404);
    });

    it("should prevent directory traversal and block path escaping outside UI_DIR", async () => {
      const traversalPaths = [
        "/ui/../package.json",
        "/ui/../../package.json",
        "/ui/..%2fpackage.json",
        "/ui/%2e%2e/package.json"
      ];

      for (const p of traversalPaths) {
        const res = await fetch(`${expressUrlDefault}${p}`);
        assert.equal(res.status, 404, `Expected 404 for traversal path: ${p}`);
      }
    });

    it("should set Cache-Control: no-store and X-Content-Type-Options: nosniff on API responses", async () => {
      const res = await fetch(`${expressUrlDefault}/api/queues/mail-queue/metrics`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");

      const resErr = await fetch(`${expressUrlDefault}/api/queues/unregistered-queue-xyz/metrics`);
      assert.equal(resErr.status, 404);
      assert.equal(resErr.headers.get("cache-control"), "no-store");
      assert.equal(resErr.headers.get("x-content-type-options"), "nosniff");
    });

    it("should safely handle URL-encoded special characters in queue names", async () => {
      const encodedName = encodeURIComponent("special/queue name#1");
      const res = await fetch(`${expressUrlDefault}/api/queues/${encodedName}/metrics`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.queue, "special/queue name#1");
      assert.equal(data.metrics.waiting, 1);
    });
  });

  describe("Fastify Plugin Adapter E2E Verification", () => {
    class TestFastifyHarness {
      constructor() {
        this.routes = new Map();
      }

      get(path, options, handler) {
        if (typeof options === "function") {
          handler = options;
          options = {};
        }
        this.routes.set(path, { options, handler });
      }

      async invoke(path, params = {}, query = {}) {
        const route = this.routes.get(path);
        if (!route) {
          return { statusCode: 404, headers: {}, body: null };
        }

        const headers = {};
        let statusCode = 200;
        let responseBody = null;

        const reply = {
          code(c) { statusCode = c; return reply; },
          status(c) { statusCode = c; return reply; },
          type(t) { headers["content-type"] = t; return reply; },
          header(k, v) { headers[k.toLowerCase()] = v; return reply; },
          send(b) { responseBody = b; return reply; }
        };

        const request = { params, query };
        if (typeof route.options?.preHandler === "function") {
          const preResult = await route.options.preHandler(request, reply);
          if (preResult === false) {
            return { statusCode, headers, body: responseBody };
          }
        }

        await route.handler(request, reply);
        return { statusCode, headers, body: responseBody };
      }
    }

    it("should register routes with Fastify and serve API and assets with security headers", async () => {
      const fastify = new TestFastifyHarness();

      await new Promise((resolve) => {
        fastifyDashboardPlugin(fastify, { queues: mockQueues }, resolve);
      });

      // API queues
      const resQueues = await fastify.invoke("/api/queues");
      assert.equal(resQueues.statusCode, 200);
      assert.equal(resQueues.headers["cache-control"], "no-store");
      assert.equal(resQueues.headers["x-content-type-options"], "nosniff");
      assert.equal(resQueues.body.queues.length, 4);

      // API metrics
      const resMetrics = await fastify.invoke("/api/queues/:queueName/metrics", { queueName: "mail-queue" });
      assert.equal(resMetrics.statusCode, 200);
      assert.equal(resMetrics.body.metrics.waiting, 12);

      // API DLQ
      const resDLQ = await fastify.invoke(
        "/api/queues/:queueName/dlq",
        { queueName: "mail-queue" },
        { start: 0, limit: 10, order: "desc" }
      );
      assert.equal(resDLQ.statusCode, 200);
      assert.equal(resDLQ.body.total, 2);

      // 501 NOT_SUPPORTED on legacy-v202-queue
      const resLegacy = await fastify.invoke(
        "/api/queues/:queueName/jobs/:jobId",
        { queueName: "legacy-v202-queue", jobId: "job-1" }
      );
      assert.equal(resLegacy.statusCode, 501);
      assert.equal(resLegacy.body.error.code, "NOT_SUPPORTED");

      // 503 QUEUE_CLOSED on closed-queue
      closedQueueState = true;
      try {
        const resClosed = await fastify.invoke(
          "/api/queues/:queueName/metrics",
          { queueName: "closed-queue" }
        );
        assert.equal(resClosed.statusCode, 503);
        assert.equal(resClosed.body.error.code, "QUEUE_CLOSED");
      } finally {
        closedQueueState = false;
      }
    });
  });

  describe("Host Authentication & Authorization Integration Examples", () => {
    it("should verify Express host authentication middleware behavior from examples/express-auth.js", () => {
      let nextCalled = false;
      const fakeRes = {
        statusCode: 200,
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        end(data) { this.body = data; }
      };

      // 1. Unauthenticated request -> 401 UNAUTHORIZED
      requireAuthentication({ headers: {} }, fakeRes, () => { nextCalled = true; });
      assert.equal(fakeRes.statusCode, 401);
      assert.equal(fakeRes.headers["Cache-Control"], "no-store");
      assert.equal(fakeRes.headers["X-Content-Type-Options"], "nosniff");
      const errPayload = JSON.parse(fakeRes.body);
      assert.equal(errPayload.error.code, "UNAUTHORIZED");
      assert.equal(nextCalled, false);

      // 2. Authenticated request with x-admin-key -> passes to next() with req.user attached
      const authReq = { headers: { "x-admin-key": "super-secret-admin-key" } };
      requireAuthentication(authReq, fakeRes, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      assert.equal(authReq.user?.role, "admin");
    });

    it("should verify Express host queue-level authorization middleware behavior from examples/express-auth.js", () => {
      const fakeRes = {
        statusCode: 200,
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        end(data) { this.body = data; }
      };

      // 1. Forbidden queue access -> 403 FORBIDDEN
      let nextCalled = false;
      const forbiddenReq = {
        url: "/admin/queues/api/queues/restricted-financial-queue/metrics",
        user: { role: "admin", allowedQueues: ["emails", "billing"] }
      };
      authorizeQueueAccess(forbiddenReq, fakeRes, () => { nextCalled = true; });
      assert.equal(fakeRes.statusCode, 403);
      assert.equal(nextCalled, false);

      // 2. Allowed queue access -> passes to next()
      nextCalled = false;
      const allowedReq = {
        url: "/admin/queues/api/queues/emails/metrics",
        user: { role: "admin", allowedQueues: ["emails", "billing"] }
      };
      authorizeQueueAccess(allowedReq, fakeRes, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
    });

    it("should verify Fastify host authentication and queue authorization hook from examples/fastify-auth.js", async () => {
      const createReply = () => ({
        statusCode: 200,
        headers: {},
        header(k, v) { this.headers[k] = v; return this; },
        code(c) { this.statusCode = c; return this; },
        send(b) { this.body = b; return this; }
      });

      // 1. Unauthenticated -> 401
      const reply1 = createReply();
      const res1 = await fastifyAuthHook({ headers: {}, params: {} }, reply1);
      assert.equal(res1, false);
      assert.equal(reply1.statusCode, 401);
      assert.equal(reply1.body?.error?.code, "UNAUTHORIZED");

      // 2. Unauthorized queue -> 403
      const reply2 = createReply();
      const res2 = await fastifyAuthHook(
        { headers: { "x-admin-key": "super-secret-admin-key" }, params: { queueName: "secret-vault" } },
        reply2
      );
      assert.equal(res2, false);
      assert.equal(reply2.statusCode, 403);
      assert.equal(reply2.body?.error?.code, "FORBIDDEN");

      // 3. Authorized request -> allowed
      const reply3 = createReply();
      const res3 = await fastifyAuthHook(
        { headers: { "x-admin-key": "super-secret-admin-key" }, params: { queueName: "emails" } },
        reply3
      );
      assert.notEqual(res3, false);
      assert.equal(reply3.statusCode, 200);
    });
  });
});
