"use strict";

/**
 * Safely serializes a Job descriptor, omitting non-serializable properties (such as updateProgress).
 *
 * @param {object} job Raw Job instance or object
 * @returns {object|null}
 */
function serializeJob(job) {
  if (!job || typeof job !== "object") {
    return null;
  }

  const serialized = {};
  for (const [key, value] of Object.entries(job)) {
    // Explicitly omit function-valued properties (e.g. updateProgress)
    if (typeof value === "function") {
      continue;
    }
    // Omit undefined values
    if (value !== undefined) {
      serialized[key] = value;
    }
  }

  return serialized;
}

/**
 * Pure handler for retrieving a persisted job by ID.
 *
 * @param {import("@mayurbhusare/resilient-queue").ResilientQueue} queue
 * @param {string} jobId
 * @returns {Promise<object|null>}
 */
async function handleGetJob(queue, jobId) {
  if (!queue || (typeof queue !== "object" && typeof queue !== "function")) {
    throw new TypeError("Valid ResilientQueue instance is required");
  }

  if (jobId === undefined || jobId === null || typeof jobId !== "string" || jobId.trim().length === 0) {
    throw new TypeError("jobId must be a non-empty string");
  }

  // Pre-dispatch closed check: ResilientQueue sets `isClosed = true` on queue.close()
  if (Boolean(queue.isClosed)) {
    const error = new Error("Queue is closed");
    error.code = "QUEUE_CLOSED";
    error.statusCode = 503;
    throw error;
  }

  try {
    const job = await queue.getJob(jobId.trim());
    if (!job) {
      return null;
    }

    return serializeJob(job);
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
  handleGetJob,
  serializeJob
};
