import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";

// Built output is served directly by the Bun server from ../public.
export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  build: { outDir: "../public", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:7777",
      "/ws": { target: "ws://127.0.0.1:7777", ws: true },
    },
  },
});
