"use strict";

/**
 * @mayurbhusare/resilient-queue-ui
 * Standalone administration dashboard and API adapter for @mayurbhusare/resilient-queue.
 */

const { QueueRegistry, createQueueRegistry } = require("./registry");
const { handleGetMetrics } = require("./handlers/metrics");
const { handleGetDLQ } = require("./handlers/dlq");
const { handleGetJob, serializeJob } = require("./handlers/job");
const {
  DashboardDispatcher,
  createDashboardDispatcher,
  createErrorResponse,
  parseDLQQueryParams
} = require("./dispatcher");
const { createExpressAdapter } = require("./adapters/express");
const { fastifyDashboardPlugin } = require("./adapters/fastify");

const VERSION = "0.1.0";

module.exports = {
  VERSION,
  QueueRegistry,
  createQueueRegistry,
  handleGetMetrics,
  handleGetDLQ,
  handleGetJob,
  serializeJob,
  DashboardDispatcher,
  createDashboardDispatcher,
  createExpressAdapter,
  fastifyDashboardPlugin,
  createErrorResponse,
  parseDLQQueryParams
};
