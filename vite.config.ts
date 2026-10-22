import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained dist/index.html, scripts and styles inlined: it has to
// work opened straight from a file on a lab machine, where Chrome refuses to
// load separate module scripts, and with no network.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: "./",
  build: { target: "es2022" },
  // The simulator tests run in real time; one file at a time keeps them honest.
  test: { environment: "node", testTimeout: 30_000, fileParallelism: false },
});
