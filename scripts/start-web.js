process.env.NITRO_HOST ??= process.env.NUXT_HOST ?? "0.0.0.0";
process.env.NITRO_PORT ??= process.env.NUXT_PORT ?? process.env.PORT ?? "3001";

await import("../apps/web/.output/server/index.mjs");
