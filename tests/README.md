# Tests: @mayurbhusare/resilient-queue-ui

This directory will contain automated unit and integration tests for `@mayurbhusare/resilient-queue-ui`.

## Test Plan Structure

- **`unit/`**:
  - Request dispatcher and parameter validation logic (`start`, `limit`, `order`, `jobId`).
  - Serializer tests ensuring non-serializable properties (e.g. `job.updateProgress`) are cleanly excluded.
  - Closed-queue (`503 Service Unavailable`) handling.
  - Frontend API client (`api-client.test.js`): URL construction, parameter encoding, successful JSON responses, HTTP errors, malformed responses, network failures.
  - Frontend UI components (`ui-components.test.js`): loading, empty, error, and retry states; view navigation; compatibility disclosure; dispatcher static asset serving.
- **`integration/`**:
  - Express adapter middleware tests using mocked or live `ResilientQueue` instances (`express-adapter.test.js`).
  - Fastify plugin registration and route handling tests (`fastify-adapter.test.js`).
  - Live Redis integration, metrics verification, and DLQ serialization (`live-queue.test.js`).
  - Package integrity and subpath exports validation (`packaging.test.js`).
  - Multi-adapter and security hardening verification (`framework-adapters-e2e.test.js`): custom prefixes, traversal defense, mandatory registration, core v2.0.2 compatibility disclosure, read-only guarantees, security headers, and host application authentication/authorization integration points.
- **`e2e/`**:
  - Zero-dependency headless Chromium CDP runner (`browser-runner.js`) leveraging Chrome DevTools Protocol over Node.js built-ins.
  - CDP runner protocol verification (`browser-runner.test.js`): WebSocket RFC 6455 framing, masked pong replies, fragmentation reassembly, command timeouts, and connection close cleanup.
  - Browser smoke testing (`browser-smoke.test.js`): uncaught JS exceptions, console errors, state rendering, view navigation, direct hash routing, responsive viewport layouts, and polling timer lifecycle.
  - End-to-end user journeys (`browser-workflows.test.js`): metric refreshes, client-side search/filtering/sorting, DLQ inspection, Job Inspector across all 4 operational states, race conditions and stale response guards, and keyboard navigation.

Tests are maintained independently of the core library test suites.
