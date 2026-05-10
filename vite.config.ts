import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    open: true,
    fs: {
      // Permite servir o 4D.ifc da raiz do projeto
      allow: [".."],
    },
  },
  optimizeDeps: {
    exclude: ["web-ifc"],
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
});
