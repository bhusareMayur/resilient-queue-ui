# Tests: @mayurbhusare/resilient-queue-ui

This directory will contain automated unit and integration tests for `@mayurbhusare/resilient-queue-ui`.

## Test Plan Structure

- **`unit/`**:
  - Request dispatcher and parameter validation logic (`start`, `limit`, `order`, `jobId`).
  - Serializer tests ensuring non-serializable properties (e.g. `job.updateProgress`) are cleanly excluded.
  - Closed-queue (`503 Service Unavailable`) handling.
- **`integration/`**:
  - Express adapter middleware tests using mocked or live `ResilientQueue` instances.
  - Fastify plugin registration and route handling tests.
  - DLQ pagination and corrupted JSON error handling tests against test Redis data.

Tests will be maintained independently of the core library test suites.
