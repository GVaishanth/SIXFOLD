import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Preloads the bundled display face by its hashed file name.
 *
 * `@font-face` cannot be preloaded from index.html by hand — Vite rewrites the
 * asset URL, and the name changes with every content edit — so the tag is built
 * from the emitted bundle. This is what makes `font-display: swap` actually
 * swap rather than flash the system face for a frame on a cold load.
 */
function preloadDisplayFont(): PluginOption {
  return {
    name: 'sixfold:preload-display-font',
    enforce: 'post',
    transformIndexHtml(_html, ctx) {
      const bundle = ctx.bundle;
      if (!bundle) return [];
      const file = Object.keys(bundle).find((key) => /\.woff2?$/i.test(key));
      if (!file) return [];
      return [
        {
          tag: 'link',
          attrs: {
            rel: 'preload',
            as: 'font',
            type: file.endsWith('.woff2') ? 'font/woff2' : 'font/woff',
            // Relative to the document, like every other asset URL Vite emits, so
            // a project page served from /<repository>/ resolves it correctly.
            href: `./${file}`,
            crossorigin: '',
          },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

/**
 * GitHub Pages compatible configuration.
 *
 * The deployment path is configurable so the same source can be deployed to
 * `https://<user>.github.io/<repository>/` (CI sets VITE_BASE_PATH to
 * `/${repository}/`) or to a custom domain / user page where the app is served
 * from the domain root (`VITE_BASE_PATH=/`).
 */
export default defineConfig(({ command }) => {
  const basePath = process.env.VITE_BASE_PATH ?? (command === 'build' ? './' : '/');

  return {
    base: basePath,
    plugins: [react(), preloadDisplayFont()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      target: 'es2021',
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: false,
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks: {
            phaser: ['phaser'],
            react: ['react', 'react-dom'],
          },
        },
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      // The dev/preview server is used from proxied sandbox hosts and from
      // phones on the local network, so host checking is disabled on purpose.
      allowedHosts: true,
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      allowedHosts: true,
    },
  };
});
