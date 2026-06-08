export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  devServer: {
    host: process.env.NUXT_HOST ?? "0.0.0.0",
    port: Number(process.env.NUXT_PORT ?? 3001)
  },
  typescript: { strict: true },
  css: ["~/assets/css/main.css"],
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
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }]
    }
  }
});
