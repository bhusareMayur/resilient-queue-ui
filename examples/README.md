# Examples: @mayurbhusare/resilient-queue-ui

This directory will provide runnable reference integration examples demonstrating how to embed `@mayurbhusare/resilient-queue-ui` inside various Node.js server frameworks.

## Planned Examples

1. **`express-basic/`**:
   - Mounting the dashboard UI and REST API as Express middleware.
   - Supplying multiple named `ResilientQueue` instances.
   - Enforcing basic authentication / session protection before reaching dashboard routes.

2. **`fastify-basic/`**:
   - Registering the dashboard as a Fastify plugin.
   - Route prefixing and schema validation.

3. **`standalone-server/`**:
   - Running a dedicated dashboard process connecting to Redis independently of worker/producer processes.
