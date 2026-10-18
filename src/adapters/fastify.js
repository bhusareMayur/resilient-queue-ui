"use strict";

const { createDashboardDispatcher } = require("../dispatcher");

/**
 * Fastify plugin adapter for @mayurbhusare/resilient-queue-ui.
 *
 * @param {object} fastify Fastify instance
 * @param {object} options Plugin options
 * @param {function} [done] Callback invoked when plugin registration completes
 */
function fastifyDashboardPlugin(fastify, options = {}, done) {
  const dispatcher = createDashboardDispatcher(options);

  const routeOptions = {};
  if (
    options &&
    (typeof options.preHandler === "function" ||
      Array.isArray(options.preHandler))
  ) {
    routeOptions.preHandler = options.preHandler;
  }

  fastify.get("/api/queues", routeOptions, async (request, reply) => {
    const result = await dispatcher.executeQueuesRoute();
    reply.code(result.status).send(result.body);
  });

  fastify.get(
    "/api/queues/:queueName/metrics",
    routeOptions,
    async (request, reply) => {
      const rawQueueName = request?.params?.queueName;
      const result = await dispatcher.executeMetricsRoute(rawQueueName);
      reply.code(result.status).send(result.body);
    }
  );

  fastify.get(
    "/api/queues/:queueName/dlq",
    routeOptions,
    async (request, reply) => {
      const rawQueueName = request?.params?.queueName;
      const query = request?.query || {};
      const result = await dispatcher.executeDLQRoute(rawQueueName, query);
      reply.code(result.status).send(result.body);
    }
  );

  fastify.get(
    "/api/queues/:queueName/jobs/:jobId",
    routeOptions,
    async (request, reply) => {
      const rawQueueName = request?.params?.queueName;
      const rawJobId = request?.params?.jobId;
      const result = await dispatcher.executeJobRoute(rawQueueName, rawJobId);
      reply.code(result.status).send(result.body);
    }
  );

  const { resolveUiAssetPath, sendStaticFile } = require("../dispatcher");
  const uiRoutes = [
    "/",
    "/index.html",
    "/styles.css",
    "/api-client.js",
    "/app.js",
    "/views/overview.js",
    "/views/dlq.js",
    "/views/job.js",
    "/ui",
    "/ui/",
    "/ui/index.html",
    "/ui/styles.css",
    "/ui/api-client.js",
    "/ui/app.js",
    "/ui/views/overview.js",
    "/ui/views/dlq.js",
    "/ui/views/job.js"
  ];

  for (const route of uiRoutes) {
    fastify.get(route, routeOptions, async (request, reply) => {
      const asset = resolveUiAssetPath(route);
      if (asset) {
        sendStaticFile(reply, asset.fullPath, asset.contentType);
      } else {
        reply.code(404).send({ error: { code: "ROUTE_NOT_FOUND", message: "Route not found" } });
      }
    });
  }

  if (typeof done === "function") {
    done();
    return;
  }

  return Promise.resolve();
}

module.exports = {
  fastifyDashboardPlugin
};
