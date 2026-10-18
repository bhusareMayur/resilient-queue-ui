"use strict";

/**
 * Pure handler for retrieving queue metrics and pause state.
 *
 * @param {import("@mayurbhusare/resilient-queue").ResilientQueue} queue
 * @param {object} [options]
 * @param {boolean} [options.localOnlyPaused=false]
 * @returns {Promise<{ isPaused: boolean, metrics: { waiting: number, active: number, delayed: number, dlq: number } }>}
 */
async function handleGetMetrics(queue, options = {}) {
  if (!queue || (typeof queue !== "object" && typeof queue !== "function")) {
    throw new TypeError("Valid ResilientQueue instance is required");
  }

  // Pre-dispatch closed check: ResilientQueue sets `isClosed = true` on queue.close()
  if (Boolean(queue.isClosed)) {
    const error = new Error("Queue is closed");
    error.code = "QUEUE_CLOSED";
    error.statusCode = 503;
    throw error;
  }

  const localOnly = Boolean(options && options.localOnlyPaused);

  try {
    const [isPaused, metrics] = await Promise.all([
      queue.isPaused({ localOnly }),
      queue.getMetrics()
    ]);

    return {
      isPaused: Boolean(isPaused),
      metrics: {
        waiting: Number(metrics?.waiting) || 0,
        active: Number(metrics?.active) || 0,
        delayed: Number(metrics?.delayed) || 0,
        dlq: Number(metrics?.dlq) || 0
      }
    };
  } catch (err) {
    // Defense-in-depth: Catch "Queue is closed" thrown by queue.getMetrics()
    if (
      err &&
      (err.code === "QUEUE_CLOSED" ||
        (typeof err.message === "string" && /queue is closed/i.test(err.message)))
    ) {
      const closedError = new Error("Queue is closed");
      closedError.code = "QUEUE_CLOSED";
      closedError.statusCode = 503;
      throw closedError;
    }

    throw err;
  }
}

module.exports = {
  handleGetMetrics
};
