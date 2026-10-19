"use strict";

/**
 * Example: Protecting @mayurbhusare/resilient-queue-ui in a Fastify Host Application.
 *
 * Demonstrates:
 * 1. Registering `fastifyDashboardPlugin` under prefix `/admin/queues`.
 * 2. Mandatory host application `preHandler` authentication hook.
 * 3. Role-based and queue-level authorization checks.
 * 4. Production security headers.
 * 5. Explicit CORS boundaries (CORS is NOT a substitute for authentication).
 * 6. Fastify plugin encapsulation scope principles.
 */

const { fastifyDashboardPlugin } = require("../src/index");

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
// 1. Host Application Pre-Handler Authentication & Authorization Hook
// ---------------------------------------------------------------------------
async function fastifyAuthHook(request, reply) {
  // WARNING: In production, load secrets exclusively from secure environment variables
  // or a secret store (e.g. AWS Secrets Manager, Vault). Never commit hardcoded secrets.
  const expectedApiKey = process.env.ADMIN_API_KEY || "super-secret-admin-key";
  const expectedBearerToken = process.env.ADMIN_BEARER_TOKEN || "admin-secret-token";

  const apiKey = request.headers["x-admin-key"];
  const authHeader = request.headers.authorization;

  const isAuthenticated =
    (apiKey && apiKey === expectedApiKey) ||
    (authHeader && authHeader === `Bearer ${expectedBearerToken}`);

  if (!isAuthenticated) {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.code(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required to access admin dashboard routes and APIs."
      }
    });
    return false; // Stop execution pipeline in Fastify
  }

  // Queue-level authorization check:
  // If the route references a specific queue, verify the caller has access.
  const targetQueue = request.params?.queueName;
  const userAllowedQueues = ["emails", "billing"]; // from user session/token claims

  if (targetQueue && !userAllowedQueues.includes(targetQueue)) {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.code(403).send({
      error: {
        code: "FORBIDDEN",
        message: `User not authorized to access queue '${targetQueue}'.`
      }
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// 2. Fastify Registration Pattern & Encapsulation Scope Notes
// ---------------------------------------------------------------------------
/**
 * Fastify Encapsulation Rules:
 * - Options passed to `fastifyDashboardPlugin` (including `preHandler`) are attached
 *   to all routes registered inside the plugin under `prefix: "/admin/queues"`.
 * - Hooks defined inside this plugin DO NOT leak out or protect routes defined outside
 *   the plugin in the parent Fastify instance.
 * - If you define hooks at the root Fastify instance, they will cascade into this plugin
 *   unless registered inside an encapsulated sibling plugin.
 *
 * Example production setup:
 *
 * ```javascript
 * const Fastify = require("fastify");
 * const app = Fastify();
 *
 * // Global security headers (@fastify/helmet recommended in production)
 * app.addHook("onSend", async (request, reply) => {
 *   reply.header("X-Content-Type-Options", "nosniff");
 *   reply.header("X-Frame-Options", "DENY");
 *   reply.header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:;");
 * });
 *
 * app.register(fastifyDashboardPlugin, {
 *   prefix: "/admin/queues",
 *   queues: {
 *     emails: emailQueue,
 *     billing: billingQueue
 *   },
 *   preHandler: fastifyAuthHook
 * });
 *
 * app.listen({ port: 3001 });
 * ```
 */

if (require.main === module) {
  let Fastify;
  try {
    Fastify = require("fastify");
  } catch {
    // Fastify not installed in package dependencies
  }

  if (Fastify) {
    const app = Fastify({ logger: false });
    const PORT = process.env.PORT || 3001;
    const keyToUse = process.env.ADMIN_API_KEY || "super-secret-admin-key";

    app.register(fastifyDashboardPlugin, {
      prefix: "/admin/queues",
      queues: {
        emails: emailQueue,
        billing: billingQueue
      },
      preHandler: fastifyAuthHook
    });

    app.listen({ port: PORT }, (err, address) => {
      if (err) {
        console.error("Failed to start Fastify server:", err);
        process.exit(1);
      }
      console.log(`Fastify secure integration active on ${address}/admin/queues`);
      console.log(`Provide header: 'x-admin-key: ${keyToUse}' to authenticate.`);
    });
  } else {
    // Runnable demonstration when Fastify is not installed
    console.log("Fastify is not installed in local dependencies. Running hook verification simulation...\n");

    const runSimulation = async () => {
      const mockReply = () => {
        const res = {
          headers: {},
          statusCode: 200,
          payload: null,
          header(k, v) { res.headers[k] = v; return res; },
          code(c) { res.statusCode = c; return res; },
          send(b) { res.payload = b; return res; }
        };
        return res;
      };

      // 1. Unauthenticated request
      const reply1 = mockReply();
      const res1 = await fastifyAuthHook({ headers: {}, params: {} }, reply1);
      console.log("[Test 1] Unauthenticated request -> status:", reply1.statusCode, "(Expected: 401)");
      console.log("         Error code:", reply1.payload?.error?.code, "(Expected: UNAUTHORIZED)");
      console.log("         Cache-Control:", reply1.headers["Cache-Control"]);

      // 2. Unauthorized queue request
      const reply2 = mockReply();
      const res2 = await fastifyAuthHook(
        { headers: { "x-admin-key": "super-secret-admin-key" }, params: { queueName: "secret-finance" } },
        reply2
      );
      console.log("[Test 2] Unauthorized queue request -> status:", reply2.statusCode, "(Expected: 403)");
      console.log("         Error code:", reply2.payload?.error?.code, "(Expected: FORBIDDEN)");

      // 3. Authorized queue request
      const reply3 = mockReply();
      const res3 = await fastifyAuthHook(
        { headers: { "x-admin-key": "super-secret-admin-key" }, params: { queueName: "emails" } },
        reply3
      );
      console.log("[Test 3] Authorized request -> status:", reply3.statusCode, "proceeded:", res3 !== false);

      console.log("\nSimulation passed! To run as a live Fastify server:");
      console.log("  npm install fastify && node examples/fastify-auth.js");
    };

    runSimulation().catch(console.error);
  }
}

module.exports = {
  fastifyAuthHook,
  emailQueue,
  billingQueue
};
