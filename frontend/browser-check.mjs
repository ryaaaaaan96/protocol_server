// Isolated browser checks use simulated API responses and never read .env or touch a database.
await import("./native-points-browser-check.mjs");
await import("./app-browser-check.mjs");
