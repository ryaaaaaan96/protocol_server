// Isolated browser checks use simulated API responses and never read .env or touch a database.
await import("./native-points-browser-check.mjs");
await import("./point-overview-browser-check.mjs");
await import("./upm-browser-check.mjs");
await import("./derived-collection-browser-check.mjs");
await import("./project-topology-browser-check.mjs");
await import("./app-browser-check.mjs");
