"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { QueueRegistry, createQueueRegistry } = require("../../src/registry");

describe("QueueRegistry", () => {
  const dummyQueue1 = { name: "dummy1", getMetrics: async () => ({}), isPaused: async () => false };
  const dummyQueue2 = { name: "dummy2", getMetrics: async () => ({}), isPaused: async () => false };

  it("should register queues from a plain Record object", () => {
    const registry = createQueueRegistry({
      queues: {
        emails: dummyQueue1,
        video: dummyQueue2
      }
    });

    assert.equal(registry.size, 2);
    assert.equal(registry.has("emails"), true);
    assert.equal(registry.has("video"), true);
    assert.equal(registry.has("unknown"), false);
    assert.equal(registry.get("emails"), dummyQueue1);
    assert.equal(registry.get("video"), dummyQueue2);
    assert.deepEqual(registry.getNames().sort(), ["emails", "video"].sort());
  });

  it("should register queues from a Map", () => {
    const map = new Map();
    map.set("orders", dummyQueue1);
    map.set("notifications", dummyQueue2);

    const registry = new QueueRegistry({ queues: map });

    assert.equal(registry.size, 2);
    assert.equal(registry.has("orders"), true);
    assert.equal(registry.has("notifications"), true);
    assert.equal(registry.get("orders"), dummyQueue1);
    assert.equal(registry.get("notifications"), dummyQueue2);
  });

  it("should register queues from an array of RegisteredQueueEntry objects", () => {
    const registry = createQueueRegistry({
      queues: [
        { name: "billing", queue: dummyQueue1 },
        { name: "analytics", queue: dummyQueue2 }
      ]
    });

    assert.equal(registry.size, 2);
    assert.equal(registry.has("billing"), true);
    assert.equal(registry.has("analytics"), true);
    assert.equal(registry.get("billing"), dummyQueue1);
  });

  it("should throw TypeError when options or options.queues is missing or invalid", () => {
    assert.throws(() => new QueueRegistry(), {
      name: "TypeError",
      message: /Dashboard adapter options must be an object/
    });

    assert.throws(() => new QueueRegistry({}), {
      name: "TypeError",
      message: /options\.queues is required/
    });

    assert.throws(() => new QueueRegistry({ queues: 123 }), {
      name: "TypeError",
      message: /options\.queues must be an object, Map, or array/
    });
  });

  it("should throw TypeError when queue entry in array is not an object", () => {
    assert.throws(
      () => new QueueRegistry({ queues: ["not-an-object"] }),
      {
        name: "TypeError",
        message: /Each queue entry in the array must be an object/
      }
    );
  });

  it("should throw TypeError when queue name is invalid or empty", () => {
    assert.throws(
      () => new QueueRegistry({ queues: { "": dummyQueue1 } }),
      {
        name: "TypeError",
        message: /Queue name must be a non-empty string/
      }
    );

    assert.throws(
      () => new QueueRegistry({ queues: { "   ": dummyQueue1 } }),
      {
        name: "TypeError",
        message: /Queue name must be a non-empty string/
      }
    );
  });

  it("should throw TypeError when queue instance is missing or invalid", () => {
    assert.throws(
      () => new QueueRegistry({ queues: { emails: null } }),
      {
        name: "TypeError",
        message: /Queue instance is required for queue 'emails'/
      }
    );
  });

  it("should reject duplicate queue names during array registration", () => {
    assert.throws(
      () =>
        new QueueRegistry({
          queues: [
            { name: "emails", queue: dummyQueue1 },
            { name: "emails", queue: dummyQueue2 }
          ]
        }),
      {
        name: "Error",
        message: /Duplicate queue name registered: 'emails'/
      }
    );
  });

  it("should return undefined for non-existent queues or invalid lookup keys", () => {
    const registry = createQueueRegistry({ queues: { emails: dummyQueue1 } });

    assert.equal(registry.get("nonexistent"), undefined);
    assert.equal(registry.get(null), undefined);
    assert.equal(registry.get(""), undefined);
    assert.equal(registry.has(""), false);
    assert.equal(registry.has(null), false);
  });
});
