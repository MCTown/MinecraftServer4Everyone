import { access, cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "./config.js";

/** Replace the runtime snapshot, never merge obsolete bundled files into it. */
export async function syncReferenceTemplate(source: string, destination: string) {
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(`${destination}.staging-`);
  const backup = `${staging}.previous`;
  let movedPrevious = false;
  try {
    await cp(source, staging, { recursive: true, force: true });
    try {
      await rename(destination, backup);
      movedPrevious = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (movedPrevious) await rename(backup, destination);
      throw error;
    }
    // Keep the previous snapshot for recovery; it is not used for new instances.
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function ensureRuntimeDirectories() {
  await Promise.all([
    mkdir(appConfig.workspaceRoot, { recursive: true }),
    mkdir(appConfig.serversDir, { recursive: true }),
    mkdir(appConfig.serverSlotsDir, { recursive: true }),
    mkdir(appConfig.deletedServersDir, { recursive: true }),
    mkdir(appConfig.tempUploadsDir, { recursive: true }),
    mkdir(appConfig.jdksDir, { recursive: true }),
    mkdir(appConfig.pythonDir, { recursive: true }),
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

  const bundledReferenceTemplate = path.join(appConfig.projectRoot, "templates", "reference");
  const referenceTemplate = path.join(appConfig.templatesDir, "reference");
  if (await access(bundledReferenceTemplate).then(() => true).catch(() => false)) {
    await syncReferenceTemplate(bundledReferenceTemplate, referenceTemplate);
  }
}
