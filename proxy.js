import { loadConnectorConfig } from "./connector/config.js";
import { createConnector } from "./connector/server.js";

const host = process.env.PROXY_HOST ?? process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PROXY_PORT ?? process.env.PORT ?? 1143);
const config = loadConnectorConfig();
if (config.secretKey === "dev-secret-change-me") console.warn("[connector] 警告：请在公开部署前设置高强度 APP_SECRET_KEY");
if (!config.password) console.warn("[connector] 警告：面板密码认证已关闭，请勿直接暴露到公网");
const server = createConnector(config);

server.listen(port, host, () => {
  console.log(`[connector] listening on http://${host}:${port}`);
  const registry = server.nodeRegistry.snapshot();
  console.log(`[connector] ${registry.nodes.length} backend node(s), default: ${registry.defaultNodeId || 'none'}`);
  console.log(`[connector] web -> ${config.webTarget}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    server.destroyConnections();
  });
}
