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
        lastUpdated: null
      };

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
        const route = window.location.hash.replace(/^#\/?/, "");
        if (route && this.viewTitles[route]) {
          this.state.activeView = route;
        }
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

      this.state.loading = true;
      this.state.error = null;
      this.updateStatusIndicator("loading", "Fetching metrics...");

      if (this.state.activeView === "overview") {
        this.renderView();
      }

      try {
        const response = await this.apiClient.getQueues();
        this.state.queues = Array.isArray(response?.queues) ? response.queues : [];
        this.state.loading = false;
        this.state.lastUpdated = new Date();
        this.updateStatusIndicator("online", `Connected (${this.state.queues.length} queues)`);
      } catch (err) {
        this.state.loading = false;
        this.state.error = err;
        this.updateStatusIndicator("offline", "API Error");
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
     */
    navigate(viewName) {
      if (!this.viewTitles[viewName]) {
        viewName = "overview";
      }

      this.state.activeView = viewName;

      if (typeof window !== "undefined" && window.location) {
        window.location.hash = `#/${viewName}`;
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
        html = DLQView.render(this.state.queues);
      } else if (this.state.activeView === "job") {
        html = JobView.render();
      }

      container.innerHTML = html;

      // Bind retry button if present
      const retryBtn = document.getElementById("retry-overview-btn");
      if (retryBtn) {
        retryBtn.addEventListener("click", () => {
          this.fetchQueues();
        });
      }
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
        });
      }
    }

    /**
     * Listens for browser URL hash changes for lightweight SPA routing.
     */
    bindHashRouting() {
      if (typeof window === "undefined") return;

      window.addEventListener("hashchange", () => {
        const route = window.location.hash.replace(/^#\/?/, "");
        if (route && this.viewTitles[route] && route !== this.state.activeView) {
          this.navigate(route);
        }
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
