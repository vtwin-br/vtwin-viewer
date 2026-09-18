import { defineConfig, loadEnv } from "vite";
import { aiProxyPlugin } from "./server/aiProxy.mjs";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  return {
    plugins: [aiProxyPlugin(env)],
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
  };
});
