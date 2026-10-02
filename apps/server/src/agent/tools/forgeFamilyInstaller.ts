export type ForgeFamilyLoader = "forge" | "neoforge";

/** Keep standalone, CurseForge manifest and mrpack installs on the same Maven coordinates. */
export function resolveForgeFamilyInstaller(loader: ForgeFamilyLoader, minecraftVersion: string, loaderVersion: string, platform: NodeJS.Platform = process.platform) {
  const versionPattern = /^\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.-]+)?$/;
  if (!versionPattern.test(minecraftVersion)) throw new Error(`无效的 Minecraft 版本：${minecraftVersion}`);
  const legacyNeoForge = loader === "neoforge" && minecraftVersion === "1.20.1";
  const version = legacyNeoForge && loaderVersion.startsWith(`${minecraftVersion}-`)
    ? loaderVersion.slice(minecraftVersion.length + 1)
    : loaderVersion;
  if (!versionPattern.test(version)) throw new Error(`无效的 ${loader} 版本：${loaderVersion}`);
  if (loader === "neoforge" && legacyNeoForge !== version.startsWith("47.")) {
    throw new Error("NeoForge 47.x 仅适用于 Minecraft 1.20.1；请使用整合包指定的 Minecraft/NeoForge 版本组合");
  }

  // NeoForge 1.20.1 was published as net.neoforged:forge; newer versions use net.neoforged:neoforge.
  const group = loader === "forge" ? "minecraftforge" : "neoforged";
  const artifact = loader === "forge" || legacyNeoForge ? "forge" : "neoforge";
  const coordinate = artifact === "forge" ? `${minecraftVersion}-${version}` : version;
  const repository = loader === "forge" ? "https://maven.minecraftforge.net" : "https://maven.neoforged.net/releases";
  const artifactPath = `net/${group}/${artifact}/${coordinate}`;
  const installerFileName = `${artifact}-${coordinate}-installer.jar`;
  return {
    version,
    installerFileName,
    installerUrl: `${repository}/${artifactPath}/${installerFileName}`,
    argsPath: `libraries/${artifactPath}/${platform === "win32" ? "win_args.txt" : "unix_args.txt"}`,
    installFlag: loader === "forge" ? "-installServer" : "--installServer"
  };
}
