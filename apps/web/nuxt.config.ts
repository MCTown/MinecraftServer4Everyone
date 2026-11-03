export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  devServer: {
    host: process.env.NUXT_HOST ?? "0.0.0.0",
    port: Number(process.env.NUXT_PORT ?? 3000)
  },
  typescript: { strict: true },
  css: [
    "vuefinder/dist/style.css",
    "~/assets/css/components/settings.css",
    "~/assets/css/components/dialogs.css",
    "~/assets/css/main.css",
    "~/assets/css/layout/command-bridge.css",
    "~/assets/css/components/agent.css",
    "~/assets/css/components/dashboard.css",
    "~/assets/css/components/instance-topbar.css",
    "~/assets/css/components/console-toolbar.css",
    "~/assets/css/components/icons.css",
    "~/assets/css/components/loading.css",
    "~/assets/css/components/settings-redesign.css",
    // Global appearance is layered last, including all workspace and dialog styles.
    "~/assets/css/theme.css",
    "~/assets/css/layout/server-workspace-mobile.css",
    "~/assets/css/components/file-workspace.css"
  ],
  runtimeConfig: {
    apiBase: process.env.NUXT_API_BASE ?? process.env.NUXT_PUBLIC_API_BASE ?? `http://127.0.0.1:${process.env.APP_PORT ?? 8787}`,
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE ?? "",
      wsBase: process.env.NUXT_PUBLIC_WS_BASE ?? ""
    }
  },
  app: {
    head: {
      title: "Minecraft Server Agent",
      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }]
    }
  }
});
