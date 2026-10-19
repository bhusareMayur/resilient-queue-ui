# Integration Examples: @mayurbhusare/resilient-queue-ui

Runnable and reference examples demonstrating how to embed `@mayurbhusare/resilient-queue-ui` inside Node.js applications with authentication, authorization, and production hardening.

---

## Available Examples

### 1. `dev-server.js` (Local UI Development & Preview)
A standalone HTTP server serving the dashboard with simulated queues, DLQ records, and job descriptors. Does not require Redis and is ideal for UI inspection and local styling tests.

```bash
node examples/dev-server.js
# Open http://localhost:3000 in your browser
```

### 2. `express-auth.js` (Express with Authentication & Authorization)
Demonstrates production-ready integration in an Express application:
- Mounting `createExpressAdapter` at `/admin/queues`.
- Enforcing mandatory authentication middleware (Bearer token, API key, or session) on all UI asset requests and API endpoints.
- Implementing queue-level authorization to restrict specific queues to authorized users or roles.
- Setting defense-in-depth security headers (`Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`).
- Clarifying that CORS headers are not a substitute for authentication.

```bash
node examples/express-auth.js
```

### 3. `fastify-auth.js` (Fastify Plugin with `preHandler` Hook)
Demonstrates production-ready integration in a Fastify application:
- Registering `fastifyDashboardPlugin` under prefix `/admin/queues`.
- Using Fastify's `preHandler` hook option to enforce authentication before any route logic executes.
- Enforcing queue-level authorization checks.
- Handling unauthorized requests with appropriate HTTP 401 / 403 JSON envelopes.

---

## Security Principles for Host Integration

1. **No Built-in Authentication**: `@mayurbhusare/resilient-queue-ui` does not include user credentials, login screens, or session management. Host applications MUST apply an authentication barrier.
2. **Protect Both UI and API**: Both HTML/JS static asset routes and `/api/*` endpoints must sit behind your authentication middleware or gateway.
3. **CORS is Not Authentication**: Enabling CORS headers (`Access-Control-Allow-Origin: *`) does not authenticate or protect an API; never expose unauthenticated dashboard endpoints to cross-origin browsers or the public web.
4. **Queue Authorization**: If different teams or tenants share the same Redis cluster, apply queue-level authorization checks in your host middleware to prevent cross-queue data inspection.

For complete architectural details, threat models, and checklists, see [docs/security.md](../docs/security.md).
