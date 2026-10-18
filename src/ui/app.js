"use strict";

/**
 * ResilientQueue Dashboard Application Controller
 * Handles routing, state management, API consumption, and view rendering.
 */

(function () {
  const ApiClientClass =
    (typeof ResilientQueueApiClient !== "undefined" && ResilientQueueApiClient.ApiClient) ||
    (typeof require === "function" ? require("./api-client").ApiClient : null);

  const OverviewView =
    (typeof ResilientQueueOverviewView !== "undefined" && ResilientQueueOverviewView) ||
    (typeof require === "function" ? require("./views/overview") : null);

  const DLQView =
    (typeof ResilientQueueDLQView !== "undefined" && ResilientQueueDLQView) ||
    (typeof require === "function" ? require("./views/dlq") : null);

  const JobView =
    (typeof ResilientQueueJobView !== "undefined" && ResilientQueueJobView) ||
    (typeof require === "function" ? require("./views/job") : null);

  class DashboardApp {
    constructor(options = {}) {
      this.containerId = options.containerId || "content-container";
      this.titleId = options.titleId || "view-title";
      this.statusDotId = options.statusDotId || "status-dot";
      this.statusTextId = options.statusTextId || "status-text";

      // Detect base URL from options, meta tag, or current URL
      let baseUrl = options.baseUrl || "";
      if (!baseUrl && typeof document !== "undefined") {
        const metaTag = document.querySelector('meta[name="api-base-url"]');
        if (metaTag && metaTag.content) {
          baseUrl = metaTag.content;
        } else if (typeof window !== "undefined" && window.location) {
          // If mounted under /admin/queues, detect basePath
          const pathname = window.location.pathname.replace(/\/ui(?:\/.*)?$/, "").replace(/\/index\.html$/, "");
          baseUrl = pathname.replace(/\/+$/, "");
        }
      }

      this.apiClient = options.apiClient || (ApiClientClass ? new ApiClientClass({ baseUrl }) : null);

      this.state = {
        activeView: "overview",
        queues: [],
        loading: false,
        error: null,
        lastUpdated: null,

        // Dead Letter Queue (DLQ) Explorer State
        dlq: {
          selectedQueue: null,
          start: 0,
          limit: 50,
          order: "desc",
          total: 0,
          jobs: [],
          loading: false,
          error: null,
          expandedJobIndex: null
        }
      };

      this._queuesRequestId = 0;
      this._dlqRequestId = 0;

      this.viewTitles = {
        overview: "Queue Overview",
        dlq: "Dead Letter Queue (DLQ)",
        job: "Job Inspection"
      };
    }

    /**
     * Initializes DOM bindings and loads initial data.
     */
    init() {
      this.bindNavigation();
      this.bindMobileToggle();
      this.bindRefresh();
      this.bindHashRouting();

      // Initial route from URL hash if present
      if (typeof window !== "undefined" && window.location.hash) {
        this.handleHashChange();
      }

      this.fetchQueues();
    }

    /**
     * Fetches queue metrics from GET /api/queues and updates view.
     */
    async fetchQueues() {
      if (!this.apiClient) {
        return;
      }

      const requestId = ++this._queuesRequestId;

      this.state.loading = true;
      this.state.error = null;
      this.updateStatusIndicator("loading", "Fetching metrics...");

      if (this.state.activeView === "overview") {
        this.renderView();
      }

      try {
        const response = await this.apiClient.getQueues();
        if (requestId !== this._queuesRequestId) {
          return;
        }

        this.state.queues = Array.isArray(response?.queues) ? response.queues : [];
        this.state.loading = false;
        this.state.lastUpdated = new Date();
        this.updateStatusIndicator("online", `Connected (${this.state.queues.length} queues)`);

        // If on DLQ view without selected queue, pick a candidate
        if (this.state.activeView === "dlq" && !this.state.dlq.selectedQueue && this.state.queues.length > 0) {
          const candidate = this.state.queues.find((q) => (q?.metrics?.dlq || 0) > 0) || this.state.queues[0];
          if (candidate?.name) {
            this.state.dlq.selectedQueue = candidate.name;
            this.fetchDLQ();
          }
        }
      } catch (err) {
        if (requestId !== this._queuesRequestId) {
          return;
        }

        this.state.loading = false;
        this.state.error = err;
        this.updateStatusIndicator("offline", "API Error");
      }

      this.renderView();
    }

    /**
     * Fetches Dead Letter Queue items for the currently selected queue.
     */
    async fetchDLQ() {
      if (!this.apiClient || !this.state.dlq.selectedQueue) {
        return;
      }

      const requestId = ++this._dlqRequestId;
      const requestedQueue = this.state.dlq.selectedQueue;

      this.state.dlq.loading = true;
      this.state.dlq.error = null;
      this.renderView();

      try {
        const response = await this.apiClient.getQueueDLQ(requestedQueue, {
          start: this.state.dlq.start,
          limit: this.state.dlq.limit,
          order: this.state.dlq.order
        });

        if (requestId !== this._dlqRequestId || this.state.dlq.selectedQueue !== requestedQueue) {
          return;
        }

        this.state.dlq.loading = false;
        this.state.dlq.jobs = Array.isArray(response?.jobs) ? response.jobs : [];
        this.state.dlq.total = typeof response?.total === "number" ? response.total : this.state.dlq.jobs.length;
        this.state.dlq.start = typeof response?.start === "number" ? response.start : this.state.dlq.start;
        this.state.dlq.limit = typeof response?.limit === "number" ? response.limit : this.state.dlq.limit;
        this.state.dlq.order = response?.order || this.state.dlq.order;
      } catch (err) {
        if (requestId !== this._dlqRequestId || this.state.dlq.selectedQueue !== requestedQueue) {
          return;
        }

        this.state.dlq.loading = false;
        this.state.dlq.error = err;
        this.state.dlq.jobs = [];
      }

      this.renderView();
    }

    /**
     * Updates top-bar status dot and text.
     */
    updateStatusIndicator(state, text) {
      if (typeof document === "undefined") return;

      const dot = document.getElementById(this.statusDotId);
      const label = document.getElementById(this.statusTextId);

      if (dot) {
        dot.className = "status-dot";
        if (state === "loading") dot.classList.add("loading");
        if (state === "offline") dot.classList.add("offline");
      }

      if (label && text) {
        label.textContent = text;
      }
    }

    /**
     * Switches the active navigation view.
     *
     * @param {"overview"|"dlq"|"job"} viewName
     * @param {object} [params={}] Optional routing parameters (e.g. { queue: "emails" })
     */
    navigate(viewName, params = {}) {
      if (!this.viewTitles[viewName]) {
        viewName = "overview";
      }

      this.state.activeView = viewName;

      if (viewName === "dlq") {
        if (params.queue) {
          this.state.dlq.selectedQueue = params.queue;
          this.state.dlq.start = 0;
          this.state.dlq.expandedJobIndex = null;
          this.fetchDLQ();
        } else if (!this.state.dlq.selectedQueue && this.state.queues.length > 0) {
          const candidate = this.state.queues.find((q) => (q?.metrics?.dlq || 0) > 0) || this.state.queues[0];
          if (candidate?.name) {
            this.state.dlq.selectedQueue = candidate.name;
            this.state.dlq.start = 0;
            this.state.dlq.expandedJobIndex = null;
            this.fetchDLQ();
          }
        }
      }

      if (typeof window !== "undefined" && window.location) {
        let hash = `#/${viewName}`;
        if (viewName === "dlq" && this.state.dlq.selectedQueue) {
          hash += `?queue=${encodeURIComponent(this.state.dlq.selectedQueue)}`;
        }
        window.location.hash = hash;
      }

      this.updateNavigationUI();
      this.renderView();
      this.closeMobileSidebar();
    }

    /**
     * Updates active styling and ARIA attributes on sidebar links.
     */
    updateNavigationUI() {
      if (typeof document === "undefined") return;

      const navButtons = document.querySelectorAll(".sidebar-nav .nav-link");
      navButtons.forEach((btn) => {
        const targetView = btn.getAttribute("data-view");
        if (targetView === this.state.activeView) {
          btn.classList.add("active");
          btn.setAttribute("aria-current", "page");
        } else {
          btn.classList.remove("active");
          btn.removeAttribute("aria-current");
        }
      });

      const titleEl = document.getElementById(this.titleId);
      if (titleEl) {
        titleEl.textContent = this.viewTitles[this.state.activeView] || "Dashboard";
      }
    }

    /**
     * Renders active view into content container.
     */
    renderView() {
      if (typeof document === "undefined") return;

      const container = document.getElementById(this.containerId);
      if (!container) return;

      const activeElementId = document.activeElement ? document.activeElement.id : null;
      const activeJobIndex = document.activeElement && document.activeElement.classList?.contains("dlq-inspect-btn")
        ? document.activeElement.getAttribute("data-job-index")
        : null;

      let html = "";

      if (this.state.activeView === "overview") {
        if (this.state.loading && this.state.queues.length === 0) {
          html = OverviewView.renderLoading();
        } else if (this.state.error) {
          html = OverviewView.renderError(this.state.error);
        } else {
          html = OverviewView.renderData(this.state.queues);
        }
      } else if (this.state.activeView === "dlq") {
        html = DLQView.render(this.state.dlq, this.state.queues);
      } else if (this.state.activeView === "job") {
        html = JobView.render();
      }

      container.innerHTML = html;
      this.bindViewEvents();

      // Restore active focus if the element was re-rendered
      if (activeElementId) {
        const el = document.getElementById(activeElementId);
        if (el && typeof el.focus === "function") {
          el.focus();
        }
      } else if (activeJobIndex !== null) {
        const el = document.querySelector(`.dlq-inspect-btn[data-job-index="${activeJobIndex}"]`);
        if (el && typeof el.focus === "function") {
          el.focus();
        }
      }
    }

    /**
     * Attaches interactive event handlers to currently rendered view elements.
     */
    bindViewEvents() {
      if (typeof document === "undefined") return;

      // Retry overview button
      const retryOverviewBtn = document.getElementById("retry-overview-btn");
      if (retryOverviewBtn) {
        retryOverviewBtn.addEventListener("click", () => {
          this.fetchQueues();
        });
      }

      // Overview table "View DLQ" badges
      const dlqLinks = document.querySelectorAll(".view-dlq-link");
      dlqLinks.forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const queueName = link.getAttribute("data-queue");
          if (queueName) {
            this.navigate("dlq", { queue: queueName });
          }
        });
      });

      // DLQ Explorer Queue Select
      const queueSelect = document.getElementById("dlq-queue-select");
      if (queueSelect) {
        queueSelect.addEventListener("change", (e) => {
          const val = e.target.value.trim();
          this.state.dlq.selectedQueue = val || null;
          this.state.dlq.start = 0;
          this.state.dlq.expandedJobIndex = null;
          if (typeof window !== "undefined" && window.location) {
            window.location.hash = this.state.dlq.selectedQueue
              ? `#/dlq?queue=${encodeURIComponent(this.state.dlq.selectedQueue)}`
              : "#/dlq";
          }
          if (this.state.dlq.selectedQueue) {
            this.fetchDLQ();
          } else {
            this.renderView();
          }
        });
      }

      // DLQ Explorer Order Select
      const orderSelect = document.getElementById("dlq-order-select");
      if (orderSelect) {
        orderSelect.addEventListener("change", (e) => {
          this.state.dlq.order = e.target.value;
          this.state.dlq.start = 0;
          this.state.dlq.expandedJobIndex = null;
          this.fetchDLQ();
        });
      }

      // DLQ Explorer Limit Select
      const limitSelect = document.getElementById("dlq-limit-select");
      if (limitSelect) {
        limitSelect.addEventListener("change", (e) => {
          this.state.dlq.limit = parseInt(e.target.value, 10) || 50;
          this.state.dlq.start = 0;
          this.state.dlq.expandedJobIndex = null;
          this.fetchDLQ();
        });
      }

      // DLQ Explorer Refresh Button
      const dlqRefreshBtn = document.getElementById("dlq-refresh-btn");
      if (dlqRefreshBtn) {
        dlqRefreshBtn.addEventListener("click", () => {
          this.fetchDLQ();
        });
      }

      // DLQ Explorer Retry Button
      const dlqRetryBtn = document.getElementById("dlq-retry-btn");
      if (dlqRetryBtn) {
        dlqRetryBtn.addEventListener("click", () => {
          this.fetchDLQ();
        });
      }

      // DLQ Explorer Previous Page Button
      const dlqPrevBtn = document.getElementById("dlq-prev-btn");
      if (dlqPrevBtn) {
        dlqPrevBtn.addEventListener("click", () => {
          if (this.state.dlq.start > 0) {
            this.state.dlq.start = Math.max(0, this.state.dlq.start - this.state.dlq.limit);
            this.state.dlq.expandedJobIndex = null;
            this.fetchDLQ();
          }
        });
      }

      // DLQ Explorer Next Page Button
      const dlqNextBtn = document.getElementById("dlq-next-btn");
      if (dlqNextBtn) {
        dlqNextBtn.addEventListener("click", () => {
          this.state.dlq.start = this.state.dlq.start + this.state.dlq.limit;
          this.state.dlq.expandedJobIndex = null;
          this.fetchDLQ();
        });
      }

      // DLQ Explorer Job Detail Toggle Buttons
      const inspectBtns = document.querySelectorAll(".dlq-inspect-btn");
      inspectBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          const idxStr = btn.getAttribute("data-job-index");
          const idx = parseInt(idxStr, 10);
          if (!Number.isNaN(idx)) {
            this.state.dlq.expandedJobIndex = this.state.dlq.expandedJobIndex === idx ? null : idx;
            this.renderView();
          }
        });
      });
    }

    /**
     * Binds click events on sidebar navigation links.
     */
    bindNavigation() {
      if (typeof document === "undefined") return;

      const navLinks = document.querySelectorAll(".sidebar-nav .nav-link");
      navLinks.forEach((link) => {
        link.addEventListener("click", (e) => {
          e.preventDefault();
          const view = link.getAttribute("data-view");
          if (view) {
            this.navigate(view);
          }
        });
      });
    }

    /**
     * Binds mobile hamburger toggle and backdrop overlay.
     */
    bindMobileToggle() {
      if (typeof document === "undefined") return;

      const toggle = document.getElementById("mobile-toggle-btn");
      const sidebar = document.getElementById("sidebar");
      const backdrop = document.getElementById("mobile-backdrop");

      if (toggle && sidebar) {
        toggle.addEventListener("click", () => {
          const isOpen = sidebar.classList.contains("open");
          if (isOpen) {
            this.closeMobileSidebar();
          } else {
            sidebar.classList.add("open");
            toggle.setAttribute("aria-expanded", "true");
            if (backdrop) backdrop.classList.add("open");
          }
        });
      }

      if (backdrop) {
        backdrop.addEventListener("click", () => {
          this.closeMobileSidebar();
        });
      }

      // Escape key to close mobile menu
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          this.closeMobileSidebar();
        }
      });
    }

    closeMobileSidebar() {
      if (typeof document === "undefined") return;
      const sidebar = document.getElementById("sidebar");
      const toggle = document.getElementById("mobile-toggle-btn");
      const backdrop = document.getElementById("mobile-backdrop");

      if (sidebar) sidebar.classList.remove("open");
      if (toggle) toggle.setAttribute("aria-expanded", "false");
      if (backdrop) backdrop.classList.remove("open");
    }

    /**
     * Binds top-bar refresh button.
     */
    bindRefresh() {
      if (typeof document === "undefined") return;

      const refreshBtn = document.getElementById("refresh-btn");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", () => {
          this.fetchQueues();
          if (this.state.activeView === "dlq" && this.state.dlq.selectedQueue) {
            this.fetchDLQ();
          }
        });
      }
    }

    /**
     * Parses and handles browser URL hash navigation (e.g. #/dlq?queue=emails or #/job).
     */
    handleHashChange() {
      if (typeof window === "undefined" || !window.location.hash) return;

      const raw = window.location.hash.replace(/^#\/?/, "");
      let view = raw;
      let queueParam = null;

      if (raw.startsWith("dlq/")) {
        view = "dlq";
        queueParam = decodeURIComponent(raw.slice(4));
      } else if (raw.includes("?")) {
        const [viewPart, queryPart] = raw.split("?");
        view = viewPart;
        try {
          const params = new URLSearchParams(queryPart);
          queueParam = params.get("queue");
        } catch {
          // ignore malformed query
        }
      }

      if (view && this.viewTitles[view]) {
        // Avoid redundant navigations if view and queue already match current state
        if (
          this.state.activeView === view &&
          (view !== "dlq" || !queueParam || this.state.dlq.selectedQueue === queueParam)
        ) {
          return;
        }
        this.navigate(view, { queue: queueParam });
      }
    }

    /**
     * Listens for browser URL hash changes for lightweight SPA routing.
     */
    bindHashRouting() {
      if (typeof window === "undefined") return;

      window.addEventListener("hashchange", () => {
        this.handleHashChange();
      });
    }
  }

  // Universal export
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { DashboardApp };
  }

  if (typeof globalThis !== "undefined") {
    globalThis.ResilientQueueDashboardApp = DashboardApp;
  }

  // Auto-initialize when running in browser document
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        const app = new DashboardApp();
        app.init();
        globalThis.__rqDashboardApp = app;
      });
    } else {
      const app = new DashboardApp();
      app.init();
      globalThis.__rqDashboardApp = app;
    }
  }
})();
