import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4100", changeOrigin: false },
      "/healthz": "http://localhost:4100",
    },
  },
  build: {
    sourcemap: false,
    // No data: URIs — the server's CSP allows fonts/images from 'self' only.
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Code used by both the cabinet and the chief's view lives in its own
        // chunks, so check.<domain> never downloads the cabinet and vice versa.
        manualChunks(id: string) {
          if (id.includes("node_modules")) return "vendor";
          if (/\/src\/components\/(Icon|ui|charts|Message)\.tsx$|\/src\/lib\/|\/src\/api\/client\.ts$/.test(id)) return "shared";
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
});
