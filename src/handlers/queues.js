"use strict";

const { handleGetMetrics } = require("./metrics");

/**
 * Pure handler for retrieving a summary list of all explicitly registered queues,
 * their current pause state, and instantaneous metrics.
 *
 * @param {import("../registry").QueueRegistry|Map<string, object>|Record<string, object>|Array<{ name: string, queue: object }>} registry
 * @param {object} [options]
 * @param {boolean} [options.localOnlyPaused=false]
 * @returns {Promise<{ queues: Array<{ name: string, isPaused: boolean, metrics: { waiting: number, active: number, delayed: number, dlq: number } }> }>}
 */
async function handleGetQueues(registry, options = {}) {
  if (!registry || typeof registry !== "object") {
    throw new TypeError("Valid QueueRegistry instance or queue map is required");
  }

  let entries;
  if (typeof registry.getEntries === "function") {
    entries = registry.getEntries();
  } else if (registry instanceof Map) {
    entries = Array.from(registry.entries()).map(([name, queue]) => ({
      name,
      queue
    }));
  } else if (Array.isArray(registry)) {
    entries = registry;
  } else {
    entries = Object.entries(registry).map(([name, queue]) => ({
      name,
      queue
    }));
  }

  if (entries.length === 0) {
    return { queues: [] };
  }

  const localOnlyPaused = Boolean(options && options.localOnlyPaused);

  const queues = await Promise.all(
    entries.map(async ({ name, queue }) => {
      const result = await handleGetMetrics(queue, { localOnlyPaused });
      return {
        name,
        isPaused: result.isPaused,
        metrics: result.metrics
      };
    })
  );

  return { queues };
}

module.exports = {
  handleGetQueues
};
