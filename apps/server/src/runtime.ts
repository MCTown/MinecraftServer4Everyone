import { access, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "./config.js";

export async function ensureRuntimeDirectories() {
  await Promise.all([
    mkdir(appConfig.workspaceRoot, { recursive: true }),
    mkdir(appConfig.serversDir, { recursive: true }),
    mkdir(appConfig.serverSlotsDir, { recursive: true }),
    mkdir(appConfig.deletedServersDir, { recursive: true }),
    mkdir(appConfig.tempUploadsDir, { recursive: true }),
    mkdir(appConfig.jdksDir, { recursive: true }),
    mkdir(appConfig.templatesDir, { recursive: true }),
    mkdir(appConfig.skillsDir, { recursive: true }),
    mkdir(appConfig.dataDir, { recursive: true })
  ]);

  const defaultTemplate = path.join(appConfig.templatesDir, "default");
  await mkdir(defaultTemplate, { recursive: true });
  await writeFile(path.join(defaultTemplate, "eula.txt"), "eula=false\n", { flag: "wx" }).catch(() => undefined);
  await writeFile(
    path.join(defaultTemplate, "server.properties"),
    "server-port=25565\nmotd=Minecraft Server Agent\nenable-command-block=false\n",
    { flag: "wx" }
  ).catch(() => undefined);
  await writeFile(path.join(defaultTemplate, "user_jvm_args.txt"), "-Xms1G\n-Xmx2G\n", { flag: "wx" }).catch(() => undefined);
  await writeFile(
    path.join(defaultTemplate, "README_AGENT.txt"),
    "This server directory was initialized by Minecraft Server Agent. Put server.jar here or configure a custom jar file.\n",
    { flag: "wx" }
  ).catch(() => undefined);

  const fixedTemplateSource = "D:\\Desktop\\1 (1)";
  const referenceTemplate = path.join(appConfig.templatesDir, "reference");
  if (await access(fixedTemplateSource).then(() => true).catch(() => false)) {
    await cp(fixedTemplateSource, referenceTemplate, { recursive: true, force: false, errorOnExist: false }).catch(() => undefined);
  }
}
