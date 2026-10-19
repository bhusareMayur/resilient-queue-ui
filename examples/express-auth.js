"use strict";

/**
 * Example: Protecting @mayurbhusare/resilient-queue-ui in an Express Host Application.
 *
 * Demonstrates:
 * 1. Mounting the dashboard and API under `/admin/queues`.
 * 2. Mandatory host application authentication middleware (API Key / Bearer / Session).
 * 3. Role-based and queue-level authorization checks.
 * 4. Hardening with security headers (CSP, frame protection, nosniff).
 * 5. Explicit CORS boundaries (CORS is NOT a substitute for authentication).
 */

const http = require("node:http");
const { createExpressAdapter } = require("../src/index");

// Sample queues (In production, replace with: new ResilientQueue({ redisUrl, keyPrefix }))
const emailQueue = {
  isClosed: false,
  isPaused: async () => false,
  getMetrics: async () => ({ waiting: 14, active: 2, delayed: 0, dlq: 1 }),
  getDLQ: async () => ({ total: 1, jobs: [{ id: "failed-email-1", failureReason: "SMTP Timeout" }] }),
  getJob: async (id) => (id === "job-1" ? { id: "job-1", state: "completed", progress: 100 } : null)
};

const billingQueue = {
  isClosed: false,
  isPaused: async () => false,
  getMetrics: async () => ({ waiting: 3, active: 1, delayed: 0, dlq: 0 }),
  getDLQ: async () => ({ total: 0, jobs: [] }),
  getJob: async () => null
};

// ---------------------------------------------------------------------------
// 1. Host Application Authentication Middleware
// ---------------------------------------------------------------------------
function requireAuthentication(req, res, next) {
  // WARNING: In production, load secrets exclusively from secure environment variables
  // or a secret store (e.g. AWS Secrets Manager, Vault). Never commit hardcoded secrets.
  const expectedApiKey = process.env.ADMIN_API_KEY || "super-secret-admin-key";
  const expectedBearerToken = process.env.ADMIN_BEARER_TOKEN || "admin-secret-token";

  const authHeader = req.headers.authorization;
  const apiKey = req.headers["x-admin-key"];

  const isAuthenticated =
    (apiKey && apiKey === expectedApiKey) ||
    (authHeader && authHeader === `Bearer ${expectedBearerToken}`);

  if (!isAuthenticated) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(
      JSON.stringify({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required to access admin dashboard routes and APIs."
        }
      })
    );
    return;
  }

  // Attach caller context for queue-level authorization
  req.user = {
    role: "admin",
    allowedQueues: ["emails", "billing"]
  };

  next();
}

// ---------------------------------------------------------------------------
// 2. Queue-Level Authorization Middleware (Optional defense-in-depth)
// ---------------------------------------------------------------------------
function authorizeQueueAccess(req, res, next) {
  // If request targets a specific queue, verify the caller has rights to inspect it
  const match = req.url.match(/^\/admin\/queues\/api\/queues\/([^/]+)/);
  if (match) {
    const queueName = decodeURIComponent(match[1]);
    if (!req.user.allowedQueues.includes(queueName)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: `User not authorized to access queue '${queueName}'.`
          }
        })
      );
      return;
    }
  }
  next();
}

// ---------------------------------------------------------------------------
// 3. Security Headers Middleware (Production Hardening)
// ---------------------------------------------------------------------------
function applySecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:;"
  );
  next();
}

// ---------------------------------------------------------------------------
// 4. Mount Adapter under `/admin/queues`
// ---------------------------------------------------------------------------
const dashboardAdapter = createExpressAdapter({
  basePath: "/admin/queues",
  queues: {
    emails: emailQueue,
    billing: billingQueue
  }
});

// Composite pipeline demonstrating standard Express middleware order
const server = http.createServer((req, res) => {
  // Only route requests matching dashboard base path strictly (exact or subpath)
  const isDashboardPath =
    req.url === "/admin/queues" ||
    req.url.startsWith("/admin/queues/") ||
    req.url.startsWith("/admin/queues?");

  if (isDashboardPath) {
    applySecurityHeaders(req, res, () => {
      requireAuthentication(req, res, () => {
        authorizeQueueAccess(req, res, () => {
          dashboardAdapter(req, res, (err) => {
            if (err) {
              res.statusCode = 500;
              res.setHeader("Cache-Control", "no-store");
              res.setHeader("X-Content-Type-Options", "nosniff");
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }));
              return;
            }
            res.statusCode = 404;
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not Found" } }));
          });
        });
      });
    });
    return;
  }

  // Public application route
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain");
  res.end("Public application home page. Admin dashboard is protected at /admin/queues.");
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const keyToUse = process.env.ADMIN_API_KEY || "super-secret-admin-key";
  server.listen(PORT, () => {
    console.log(`Express secure integration example active on http://localhost:${PORT}/admin/queues`);
    console.log(`Provide header: 'x-admin-key: ${keyToUse}' to authenticate.`);
  });
}

module.exports = {
  server,
  requireAuthentication,
  authorizeQueueAccess,
  applySecurityHeaders
};
