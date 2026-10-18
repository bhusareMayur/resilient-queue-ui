"use strict";

/**
 * Queue Registry for @mayurbhusare/resilient-queue-ui.
 * Manages explicit registration and lookup of ResilientQueue instances.
 */
class QueueRegistry {
  constructor(options) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Dashboard adapter options must be an object");
    }

    if (!options.queues) {
      throw new TypeError(
        "options.queues is required and must be an object, Map, or array of queue entries"
      );
    }

    this._queues = new Map();
    this._normalize(options.queues);
  }

  _register(name, queue) {
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError("Queue name must be a non-empty string");
    }

    if (!queue || (typeof queue !== "object" && typeof queue !== "function")) {
      throw new TypeError(`Queue instance is required for queue '${name}'`);
    }

    const normalizedName = name.trim();
    if (this._queues.has(normalizedName)) {
      throw new Error(`Duplicate queue name registered: '${normalizedName}'`);
    }

    this._queues.set(normalizedName, queue);
  }

  _normalize(queues) {
    if (Array.isArray(queues)) {
      for (const entry of queues) {
        if (!entry || typeof entry !== "object") {
          throw new TypeError(
            "Each queue entry in the array must be an object with name and queue properties"
          );
        }
        this._register(entry.name, entry.queue);
      }
    } else if (queues instanceof Map) {
      for (const [name, queue] of queues.entries()) {
        this._register(name, queue);
      }
    } else if (typeof queues === "object" && queues !== null) {
      for (const [name, queue] of Object.entries(queues)) {
        this._register(name, queue);
      }
    } else {
      throw new TypeError(
        "options.queues must be an object, Map, or array of queue entries"
      );
    }
  }

  get(name) {
    if (!name || typeof name !== "string") {
      return undefined;
    }
    return this._queues.get(name.trim());
  }

  has(name) {
    if (!name || typeof name !== "string") {
      return false;
    }
    return this._queues.has(name.trim());
  }

  getNames() {
    return Array.from(this._queues.keys());
  }

  getEntries() {
    return Array.from(this._queues.entries()).map(([name, queue]) => ({
      name,
      queue
    }));
  }

  get size() {
    return this._queues.size;
  }
}

function createQueueRegistry(options) {
  return new QueueRegistry(options);
}

module.exports = {
  QueueRegistry,
  createQueueRegistry
};
