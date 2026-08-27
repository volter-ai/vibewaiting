import { defineConfig } from "vite";
import { almostnodePlugin } from "almostnode/vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [almostnodePlugin()],
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: "../../dist/almostnode-spike",
    emptyOutDir: true,
  },
});
