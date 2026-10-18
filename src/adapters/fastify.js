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

  if (typeof done === "function") {
    done();
    return;
  }

  return Promise.resolve();
}

module.exports = {
  fastifyDashboardPlugin
};
