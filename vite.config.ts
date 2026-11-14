import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// BASE_PATH is set by the GitHub Pages workflow (e.g. "/Jarvis/").
const base = process.env.BASE_PATH || "/";

export default defineConfig({
  base,
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png", "icons/*.svg"],
      manifest: {
        name: "J.A.R.V.I.S. — Personal Assistant",
        short_name: "Jarvis",
        description: "Your personal AI assistant for mail, calls, research, tasks and studies.",
        theme_color: "#02050b",
        background_color: "#02050b",
        display: "standalone",
        orientation: "portrait",
        start_url: ".",
        scope: ".",
        categories: ["productivity", "education", "utilities"],
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ],
        shortcuts: [
          { name: "Talk to Jarvis", url: "./?action=listen", icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] },
          { name: "Daily brief", url: "./?action=brief", icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: "CacheFirst",
            options: { cacheName: "fonts", expiration: { maxEntries: 20, maxAgeSeconds: 31536000 } }
          }
        ]
      }
    })
  ]
});
