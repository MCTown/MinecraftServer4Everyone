import { eq } from "drizzle-orm";
import os from "node:os";
import { appConfig, defaultSystemPrompt } from "../config.js";
import { getDb } from "../db/client.js";
import { appSettings } from "../db/schema.js";
import { decryptSecret, encryptSecret, maskSecret } from "../security/encrypt.js";
import type { AgentSettings, AgentToolSettings } from "../types.js";
import { nowIso } from "../utils/time.js";
import { ServerService } from "./serverService.js";
import { SkillService } from "./skillService.js";

const agentAutoConfirmKey = "agent_auto_confirm";
const agentDownloadProxyEnabledKey = "agent_download_proxy_enabled";
const agentDownloadProxyUrlKey = "agent_download_proxy_url";
const agentMemoryMbKey = "agent_memory_mb";
const curseForgeApiKeySettingKey = "curseforge_api_key";
const modrinthApiKeySettingKey = "modrinth_api_key";
const minimumAgentMemoryMb = 512;

function systemMemoryMb() {
  return Math.max(minimumAgentMemoryMb, Math.floor(os.totalmem() / 1024 / 1024));
}

function clampMemoryMb(value: number) {
  return Math.min(systemMemoryMb(), Math.max(minimumAgentMemoryMb, Math.round(value)));
}

function memoryLabel(valueMb: number) {
  return valueMb % 1024 === 0 ? `${valueMb / 1024}G` : `${valueMb}M`;
}

export class PromptService {
  constructor(private readonly serverService: ServerService, private readonly skillService: SkillService) {}

  private getSetting(key: string) {
    return getDb().select().from(appSettings).where(eq(appSettings.key, key)).get()?.value;
  }

  private setSetting(key: string, value: string) {
    getDb()
      .insert(appSettings)
      .values({ key, value, updatedAt: nowIso() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: nowIso() } })
      .run();
  }

  getAgentAutoConfirm() {
    return this.getSetting(agentAutoConfirmKey) === "true";
  }

  setAgentAutoConfirm(enabled: boolean) {
    this.setSetting(agentAutoConfirmKey, String(enabled));
    return this.getAgentAutoConfirm();
  }

  getAgentSettings(): AgentSettings {
    const savedMemory = Number(this.getSetting(agentMemoryMbKey));
    const memoryMb = clampMemoryMb(Number.isFinite(savedMemory) && savedMemory > 0 ? savedMemory : 2048);
    return {
      autoConfirm: this.getAgentAutoConfirm(),
      downloadProxyEnabled: this.getSetting(agentDownloadProxyEnabledKey) === "true",
      downloadProxyUrl: this.getSetting(agentDownloadProxyUrlKey) ?? "",
      memory: memoryLabel(memoryMb),
      memoryMb,
      systemMemoryMb: systemMemoryMb()
    };
  }

  setAgentSettings(settings: Partial<AgentSettings>) {
    if (typeof settings.autoConfirm === "boolean") this.setSetting(agentAutoConfirmKey, String(settings.autoConfirm));
    if (typeof settings.downloadProxyEnabled === "boolean") this.setSetting(agentDownloadProxyEnabledKey, String(settings.downloadProxyEnabled));
    if (typeof settings.downloadProxyUrl === "string") this.setSetting(agentDownloadProxyUrlKey, settings.downloadProxyUrl.trim());
    if (typeof settings.memoryMb === "number") this.setSetting(agentMemoryMbKey, String(clampMemoryMb(settings.memoryMb)));
    return this.getAgentSettings();
  }

  getAgentDownloadProxyUrl() {
    const settings = this.getAgentSettings();
    return settings.downloadProxyEnabled && settings.downloadProxyUrl ? settings.downloadProxyUrl : undefined;
  }

  private getDecryptedSetting(key: string) {
    const encrypted = this.getSetting(key);
    if (!encrypted) return "";
    try {
      return decryptSecret(encrypted);
    } catch {
      return "";
    }
  }

  private setSecretSetting(key: string, value: string | undefined) {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    this.setSetting(key, encryptSecret(trimmed));
  }

  getCurseForgeApiKey() {
    return this.getDecryptedSetting(curseForgeApiKeySettingKey) || appConfig.curseForgeApiKey.trim();
  }

  getModrinthApiKey() {
    return this.getDecryptedSetting(modrinthApiKeySettingKey) || appConfig.modrinthApiKey.trim();
  }

  getAgentToolSettings(): AgentToolSettings {
    const curseForgeApiKey = this.getCurseForgeApiKey();
    const modrinthApiKey = this.getModrinthApiKey();
    return {
      curseForgeApiKeyConfigured: Boolean(curseForgeApiKey),
      curseForgeApiKeyHint: maskSecret(curseForgeApiKey),
      modrinthApiKeyConfigured: Boolean(modrinthApiKey),
      modrinthApiKeyHint: maskSecret(modrinthApiKey)
    };
  }

  setAgentToolSettings(settings: Partial<{ curseForgeApiKey: string; modrinthApiKey: string }>) {
    this.setSecretSetting(curseForgeApiKeySettingKey, settings.curseForgeApiKey);
    this.setSecretSetting(modrinthApiKeySettingKey, settings.modrinthApiKey);
    return this.getAgentToolSettings();
  }

  getGlobalPrompt() {
    return this.getSetting("global_system_prompt") ?? defaultSystemPrompt;
  }

  setGlobalPrompt(value: string) {
    this.setSetting("global_system_prompt", value);
    return this.getGlobalPrompt();
  }

  resetGlobalPrompt() {
    return this.setGlobalPrompt(defaultSystemPrompt);
  }

  async getEffectivePrompt(serverId: string) {
    const server = await this.serverService.requireServer(serverId);
    const basePrompt = !server.useGlobalPrompt && server.promptOverride ? server.promptOverride : this.getGlobalPrompt();
    const skillContents = await this.skillService.getEnabledSkillContents();
    if (skillContents.length === 0) return basePrompt;
    return `${basePrompt}\n\n# Enabled Skills\n\n${skillContents.join("\n\n")}`;
  }
}
