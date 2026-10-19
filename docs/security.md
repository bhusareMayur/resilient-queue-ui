# Security Guide & Threat Model: `@mayurbhusare/resilient-queue-ui`

**Package**: `@mayurbhusare/resilient-queue-ui`  
**Core Library**: `@mayurbhusare/resilient-queue`  
**Scope**: Host Application Security, Threat Modeling, and Deployment Guidance  
**Specification Version**: `1.0.0`

---

## Table of Contents

1. [Explicit Division of Responsibilities](#1-explicit-division-of-responsibilities)
2. [Threat Model & Asset Analysis](#2-threat-model--asset-analysis)
3. [Authentication & Authorization Integration](#3-authentication--authorization-integration)
   - [Express Integration](#express-integration)
   - [Fastify Integration](#fastify-integration)
   - [Reverse Proxy & API Gateway Integration](#reverse-proxy--api-gateway-integration)
   - [Queue-Level Authorization & Multi-Tenancy](#queue-level-authorization--multi-tenancy)
4. [Sensitive Data Protection & Information Disclosure](#4-sensitive-data-protection--information-disclosure)
   - [Job Payload & Error Exposure](#job-payload--error-exposure)
   - [Error Message Sanitization](#error-message-sanitization)
   - [Logging Principles](#logging-principles)
   - [HTTP Caching Safeguards](#http-caching-safeguards)
5. [CORS, Reverse Proxies & Network Isolation](#5-cors-reverse-proxies--network-isolation)
   - [The CORS Misconception](#the-cors-misconception)
   - [Network Isolation & Private Binding](#network-isolation--private-binding)
6. [Frontend Security & Content Injection Audit](#6-frontend-security--content-injection-audit)
7. [Production Deployment Checklist](#7-production-deployment-checklist)

---

## 1. Explicit Division of Responsibilities

`@mayurbhusare/resilient-queue-ui` is designed as a lightweight, un-opinionated monitoring adapter and administration UI. It intentionally **does not** embed user authentication, password hashing, session management, or role databases.

Integrating the dashboard safely requires a clear division of responsibilities:

| Domain | `@mayurbhusare/resilient-queue-ui` (Package Scope) | Host Application & Infrastructure (Host Scope) |
| :--- | :--- | :--- |
| **Authentication** | ❌ **No built-in authentication**. Provides no login screens, cookies, or user tables. | ✅ **Mandatory**. Must enforce authentication on all dashboard routes (HTML, JS, and `/api/*`). |
| **Authorization** | ❌ **No role-based access control (RBAC)**. All registered queues are readable if requested. | ✅ **Mandatory**. Must authorize user roles and restrict queue access if sensitive queues exist. |
| **Queue Registration** | ✅ Manages explicit queue instance registry. Does not auto-discover unknown Redis keys. | ✅ Must register only the queues intended to be visible to the dashboard. |
| **Data Protection** | ✅ Automatically redacts URI credentials and secrets from 500 internal error responses. Sets `Cache-Control: no-store` on API responses. | ✅ Must redact or encrypt sensitive application payload fields (`job.data`) before enqueuing if untrusted operators have dashboard access. |
| **Network Security** | ❌ Does not manage TLS certificates, firewalls, or network interfaces. | ✅ Must enforce HTTPS/TLS termination and bind server to private networks/VPCs or trusted VPNs. |
| **HTTP Security Headers**| ✅ Emits `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` on API routes. | ✅ Must supply Content Security Policy (CSP), `X-Frame-Options`, HSTS, and referrer policies via helmet or reverse proxy. |
| **Input Validation** | ✅ Strictly validates path parameters, query parameters, types, and rejects null-byte poisoning. | ✅ Must sanitize and validate data passed to `queue.enqueue()` at job creation time. |
| **Static Assets** | ✅ Resolves UI assets with directory traversal safeguards, MIME whitelisting, and dotfile rejection. | ✅ Must serve application behind a reverse proxy or web application firewall (WAF) in production. |

---

## 2. Threat Model & Asset Analysis

### Critical Assets

1. **Job Payloads (`job.data`)**: Frequently contain user personally identifiable information (PII), email addresses, passwords, tokens, financial transaction data, or internal identifiers.
2. **Execution Results (`job.result` / `job.returnValue`)**: May reveal customer transaction receipts, external API responses, generated secrets, or internal service state.
3. **Failure Diagnostics (`job.failureReason` / `job.lastError`)**: Often contain database error stack traces, SQL syntax snippets, external vendor error messages, or internal microservice endpoints.
4. **Dead-Letter Queue (DLQ) Records**: Contain failed jobs and corrupted Redis payloads that may include raw corrupted inputs or sensitive unhandled messages.
5. **Operational Telemetry (`waiting`, `active`, `delayed`, `dlq`)**: Exposes queue traffic volume, business operational cadence, peak usage hours, and backlog bottlenecks.
6. **Infrastructure Details**: Redis connection parameters, cluster topology, internal IP addresses, and key naming conventions.

### Threat Actors & Risk Profiles

```
+-------------------------------------------------------------------------------+
|                                 THREAT ACTORS                                 |
+------------------------------------+------------------------------------------+
| Threat Actor                       | Motivation & Attack Vector               |
+------------------------------------+------------------------------------------+
| Unauthenticated External Attacker  | Discovering exposed `/admin/queues` or   |
|                                    | `/api/queues` to steal customer data,    |
|                                    | harvest PII, or map internal topology.   |
+------------------------------------+------------------------------------------+
| Low-Privilege Authenticated User   | Bypassing queue-level boundaries (BOLA)  |
|                                    | to inspect queues of other tenants or    |
|                                    | unauthorized business departments.       |
+------------------------------------+------------------------------------------+
| Cross-Origin Malicious Site        | Exploiting misconfigured CORS or CSRF to |
|                                    | read queue metrics and job descriptors   |
|                                    | via authenticated victim browsers.       |
+------------------------------------+------------------------------------------+
| Intermediate Cache / Shared Proxy  | Storing unencrypted API responses and    |
|                                    | serving sensitive customer payloads to   |
|                                    | subsequent unauthorized callers.         |
+------------------------------------+------------------------------------------+
```

### Risk Mitigations Implemented in the Package

- **Strict Read-Only Architecture**: The package provides zero mutation endpoints (`pause()`, `resume()`, `retry()`, `purge()`). Attackers cannot delete, purge, or replay jobs through this package.
- **Explicit Registration Only**: The adapter never introspects Redis for un-registered keys or namespaces. Only queues explicitly provided by application code can be queried.
- **Automatic Credential Scrubbing**: Internal Redis error strings (such as `redis://user:pass@host:6379`, `AUTH password`, or `password: "secret"`) are automatically scrubbed and redacted to `[redacted]` before reaching HTTP responses or the UI.
- **Cache Invalidation Headers**: All `/api/*` endpoints emit `Cache-Control: no-store` to prevent caching by browsers, forward proxies, or CDNs.
- **Strict Path Resolution**: Asset serving rejects directory traversal (`..`), path normalization bypasses, dotfiles (`.env`, `.git`), and non-whitelisted MIME extensions.
- **Null-Byte Poisoning Defense**: Rejects null bytes (`\0`) in route parameters (`queueName`, `jobId`).
- **Comprehensive Contextual XSS Escaping**: All dynamic data in the UI (queue names, job IDs, payloads, failure diagnostics, error messages) is strictly entity-escaped using `escapeHtml()`.

---

## 3. Authentication & Authorization Integration

Host applications **must** guard both the static dashboard routes and the `/api/*` endpoints.

### Express Integration

Mount your authentication middleware *before* the dashboard adapter:

```javascript
const express = require("express");
const { ResilientQueue } = require("@mayurbhusare/resilient-queue");
const { createExpressAdapter } = require("@mayurbhusare/resilient-queue-ui");

const app = express();

const emailQueue = new ResilientQueue({ redisUrl: process.env.REDIS_URL, keyPrefix: "rq:emails" });
const orderQueue = new ResilientQueue({ redisUrl: process.env.REDIS_URL, keyPrefix: "rq:orders" });

// 1. Host Authentication Middleware (Session / Token / Basic)
function requireAdminAuth(req, res, next) {
  // Replace with your real auth: Passport session, JWT verification, etc.
  if (req.session?.user?.role !== "admin" && req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Admin authentication required" } }));
  }
  next();
}

// 2. Security Headers Middleware
function dashboardSecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:;");
  next();
}

// 3. Mount protected dashboard under prefix
app.use(
  "/admin/queues",
  dashboardSecurityHeaders,
  requireAdminAuth,
  createExpressAdapter({
    basePath: "/admin/queues",
    queues: {
      "emails": emailQueue,
      "orders": orderQueue
    }
  })
);

app.listen(3000);
```

### Fastify Integration

In Fastify, pass your authentication hook to the `preHandler` option. The plugin automatically applies this `preHandler` hook to all API endpoints and UI asset routes:

```javascript
const Fastify = require("fastify");
const { ResilientQueue } = require("@mayurbhusare/resilient-queue");
const { fastifyDashboardPlugin } = require("@mayurbhusare/resilient-queue-ui");

const app = Fastify();

const emailQueue = new ResilientQueue({ redisUrl: process.env.REDIS_URL, keyPrefix: "rq:emails" });

// Fastify preHandler authentication hook
async function fastifyAdminAuth(request, reply) {
  const token = request.headers.authorization;
  if (!token || token !== `Bearer ${process.env.ADMIN_SECRET}`) {
    reply.header("Cache-Control", "no-store");
    reply.code(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required to access admin dashboard"
      }
    });
    return false; // Abort request pipeline
  }
}

// Register dashboard plugin under prefix with auth hook
app.register(fastifyDashboardPlugin, {
  prefix: "/admin/queues",
  queues: {
    "emails": emailQueue
  },
  preHandler: fastifyAdminAuth
});

app.listen({ port: 3000 });
```

> [!IMPORTANT]
> **Fastify Encapsulation Scope**: Fastify enforces strict encapsulation. The `preHandler` option passed to `fastifyDashboardPlugin` attaches exclusively to the routes mounted under the plugin's prefix (e.g. `/admin/queues`). It does **not** protect routes outside this plugin. Conversely, global hooks registered on root Fastify instances cascade down into child plugins unless sibling encapsulation boundaries are used.

### Reverse Proxy & API Gateway Integration

For enterprise deployments, the most resilient architecture places the dashboard behind an authenticated reverse proxy or API gateway.

```
[Browser / Operator] 
       │
       ▼ (HTTPS)
[Cloudflare Access / OAuth2-Proxy / AWS ALB / Nginx]
       │ (Enforces Corporate SSO, MFA, mTLS)
       ▼ (Private VPC Network)
[Host Node.js Application (Express / Fastify)]
       │
       ▼
[@mayurbhusare/resilient-queue-ui Adapter]
       │
       ▼
[Redis Cluster]
```

**Recommended Gateway Options**:
- **OAuth2-Proxy / Keycloak / Cloudflare Access**: Authenticates users before traffic ever reaches Node.js.
- **Nginx `auth_request`**: Sub-requests an internal authentication service before proxying to `/admin/queues`.
- **mTLS (Mutual TLS)**: Requires client certificates for access to management interfaces.

### Queue-Level Authorization & Multi-Tenancy

If multiple departments or tenants share a single backend service, do not expose all queues to every authenticated user. 

1. **Segregated Adapters**: Mount separate dashboard instances with different `options.queues` maps under distinct route prefixes:
   - `/admin/finance/queues` -> `{ "invoices": invoiceQueue, "payouts": payoutQueue }` (Requires Finance Role)
   - `/admin/ops/queues` -> `{ "video": videoQueue, "email": emailQueue }` (Requires Ops Role)
2. **Host Middleware Inspection**: In host middleware, inspect `req.params.queueName` or URL path and check user permissions before invoking `next()`.

---

## 4. Sensitive Data Protection & Information Disclosure

### Job Payload & Error Exposure

- **Payloads (`job.data`)**: The Job Inspector and DLQ Explorer display JSON payloads. If payloads contain sensitive credentials or tokens, consider masking them in worker code or avoiding persisting raw credentials in queue jobs.
- **Error Traces**: Uncaught application exceptions stored in `job.failureReason` or `job.lastError` will be visible in the DLQ Explorer. Ensure worker error handlers sanitize proprietary data before re-throwing or failing jobs.

### Error Message Sanitization

When Redis or internal operations encounter an unexpected error, the adapter catches the exception and invokes `sanitizeErrorMessage(err.message)`:

```javascript
// Example: Raw internal error
"Connection failed to redis://user:secretPassword123@db-prod.internal:6379"

// Sanitized API response
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Connection failed to redis://[redacted]@db-prod.internal:6379",
    "details": null
  }
}
```

The sanitizer automatically redacts known credential patterns:
- Redis, AMQP, Postgres, and HTTP/HTTPS connection URIs with embedded user/password credentials (including percent-encoded special characters).
- `AUTH <token>` and `Bearer <token>` commands and headers.
- Key-value secret fields such as `password=...`, `token=...`, `apikey=...`, and `api_key=...`.

> [!NOTE]
> **Pattern-Based Sanitization Scope**: The sanitizer uses regular expressions tailored to common credential formats and connection URIs. It is a defense-in-depth safeguard and does **not** claim comprehensive secret elimination across unknown, unstructured, or proprietary secret representations. Host applications remain responsible for avoiding leaking secrets into worker error messages and Redis.

### Logging Principles

`@mayurbhusare/resilient-queue-ui` strictly adheres to a **zero-logging principle** inside runtime code (`src/`):
- It **never** prints job payloads, results, or tokens to `stdout` or `stderr`.
- It **never** logs Redis connection strings.
- Host applications should ensure their own HTTP request loggers (e.g., Morgan, Pino) do not log sensitive query parameters or authorization tokens.

### HTTP Caching Safeguards

Because queue metrics and job descriptors are dynamic and sensitive:
- **API Responses (`/api/*`)**: The package explicitly emits `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **Static Assets (`index.html`, `styles.css`, `app.js`)**: Emits `Cache-Control: public, max-age=300` and `X-Content-Type-Options: nosniff`.

---

## 5. CORS, Reverse Proxies & Network Isolation

### The CORS Misconception

> [!CAUTION]
> **CORS is NOT an authentication or authorization mechanism.**  
> Cross-Origin Resource Sharing (CORS) is a browser security policy designed to *relax* the Same-Origin Policy. It informs the browser whether a web page hosted on domain A is allowed to read responses from domain B.

- **`Access-Control-Allow-Origin: *` does NOT protect your endpoint**: It allows *any* website visited by your administrators to send cross-origin requests to your internal dashboard API.
- **Do not enable permissive CORS on admin endpoints**: If your dashboard UI is served from the same origin as the API (the default behavior), CORS headers are completely unnecessary and should **not** be set.
- If the frontend and backend are hosted on separate domains, restrict `Access-Control-Allow-Origin` strictly to your trusted internal admin origin and require credentials (`Access-Control-Allow-Credentials: true`).

### Network Isolation & Private Binding

1. **Private Network Binding**: Bind administrative servers to internal loopback (`127.0.0.1`), an internal VPC subnet, or a dedicated management port rather than `0.0.0.0` on the public internet.
2. **Reverse Proxy Header Validation**: When hosting behind Nginx or AWS ALB, ensure untrusted clients cannot spoof headers like `X-Forwarded-For` or `X-Forwarded-Host`.

---

## 6. Frontend Security & Content Injection Audit

The dashboard UI was thoroughly audited for cross-site scripting (XSS) and injection vulnerabilities:

1. **Zero External Frontend Dependencies**:
   - Uses zero CDNs, zero third-party script tags, and zero remote fonts.
   - All styling and logic reside in static files (`styles.css`, `app.js`, `api-client.js`, `views/*.js`).
2. **Strict Entity Escaping**:
   - Every dynamic string inserted into the DOM (queue names, job IDs, state badges, payloads, return values, failure reasons, and diagnostics) is sanitized using `escapeHtml()`.
3. **URL & Navigation Safety**:
   - Queue names and job IDs in navigation links and hash routes are encoded using `encodeURIComponent()`.
   - Hash changes are parsed with `URLSearchParams` and validated against allowed view whitelists (`overview`, `dlq`, `job`).
4. **Corrupted JSON Handling**:
   - Corrupted or truncated JSON entries in the Dead-Letter Queue are safely rendered inside `<pre><code>` blocks with explicit error badges, without invoking un-sanitized string-to-DOM conversions.

---

## 7. Production Deployment Checklist

Use this pre-flight checklist before deploying `@mayurbhusare/resilient-queue-ui` to production:

- [ ] **1. Authentication Barrier**: The dashboard route (e.g. `/admin/queues`) and API routes (`/admin/queues/api/*`) are protected by host authentication middleware (session, OAuth2, JWT, or reverse proxy SSO).
- [ ] **2. No Unauthenticated Public Exposure**: Verified that endpoints cannot be reached from the public internet without passing through an authentication gate.
- [ ] **3. Queue-Level Authorization**: If sensitive queues exist, role-based checks verify caller permissions before displaying queue telemetry.
- [ ] **4. HTTPS / TLS Termination**: All traffic to the dashboard is encrypted with TLS (HTTPS). Plain HTTP is prohibited.
- [ ] **5. Security Headers**: Host application or reverse proxy applies `Content-Security-Policy`, `X-Frame-Options: DENY`, and `X-Content-Type-Options: nosniff`.
- [ ] **6. No Permissive CORS**: `Access-Control-Allow-Origin: *` is NOT enabled on dashboard routes.
- [ ] **7. Cache-Control Enforced**: Verified that `/api/*` endpoints return `Cache-Control: no-store` to prevent proxy or browser caching.
- [ ] **8. Network Isolation**: Management port or dashboard server is bound to a private VPC or VPN interface where possible.
- [ ] **9. Logging Sanitization**: Host application request loggers (Pino, Morgan, Winston) are configured not to log sensitive query parameters, tokens, or payloads.
- [ ] **10. Core Version Compatibility**: Host application is aware that `@mayurbhusare/resilient-queue@2.0.2` returns `501 NOT_SUPPORTED` for individual `getJob()` inspection, which will automatically activate on future core releases.
