"use strict";

/**
 * Pure handler for querying Dead-Letter Queue (DLQ) jobs.
 *
 * @param {import("@mayurbhusare/resilient-queue").ResilientQueue} queue
 * @param {object} [options]
 * @param {number} [options.start=0]
 * @param {number} [options.limit=50]
 * @param {string} [options.order="asc"]
 * @returns {Promise<{ total: number, jobs: Array<object> }>}
 */
async function handleGetDLQ(queue, options = {}) {
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

  try {
    const dlqResult = await queue.getDLQ(options);
    return {
      total: Number(dlqResult?.total) || 0,
      jobs: Array.isArray(dlqResult?.jobs) ? dlqResult.jobs : []
    };
  } catch (err) {
    // Defense-in-depth: Catch "Queue is closed" or closed errors
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
  handleGetDLQ
};
