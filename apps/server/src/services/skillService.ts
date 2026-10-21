import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { appConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { skills } from "../db/schema.js";
import { nowIso } from "../utils/time.js";

const builtInSkillId = "minecraft_deploy";
const builtInSkillName = "服务端部署 Skill";
const builtInSkillVersion = "1.16.0";
const builtInSkillDescription = "自动套用模板后的整合包安装、Java 版本依赖检查、MCDReforged 配置、启动脚本生成和常见问题检查。";
const builtInSkillContent = `# 服务端部署 Skill

用于 Minecraft 服务端部署、安装单个模组与故障排查。部署顺序和阶段技术指令由系统追加的「当前部署流程（流程编排 · 权威配置）」提供，不能使用历史固定顺序覆盖它。

## 工具使用参考（不定义部署顺序）
- 完整部署先 begin_deployment_workflow，由后端指定本轮节点；串行节点各一个 turn，并行组共用一个 turn。工具调用携带本轮 workflowStepId，所有分支和后台工具真实完成后才可汇合，由系统自动推进。普通排错/查询不启动完整流程。
- 新建服务端时后端自动套用 reference MCDReforged 模板，不重复初始化；旧实例确实缺少模板时先检查，再以 overwrite=false 补齐。
- Java 版本依据已确认的 Minecraft、Loader 与整合包依赖确定；check_java_environment 检查工作区可用安装，缺失时 install_java_version，写入并核对当前配置。Loader 安装器与启动脚本必须使用已验证的工作区 Java，不依赖系统默认 Java。
- 单个模组使用 download_mod_to_server_mods，只把 .jar 写入 server/mods/，不把 .mrpack/zip 当模组。
- 平台文件获取优先官方 API，不抓取 CurseForge Files 网页。CurseForge 缺少 Key 或鉴权失败时等待配置，申请地址 https://console.curseforge.com/?#/api-keys；Modrinth 要求 PAT 时等待配置，地址 https://modrinth.com/settings/pats。
- .mrpack 使用 inspect_mrpack_server_slot + deploy_mrpack_server_from_server_slot。CurseForge 清单使用 materialize_curseforge_manifest_pack_from_server_slot。完整服务端压缩包使用 extract_server_slot_to_workspace。文件始终放在 server/ 内。
- Forge/NeoForge 使用对应 setup 能力，优先包内 installer，缺失时下载官方指定版本；installer 不是服务端 JAR。
- 启动使用非交互方式与 nogui，提前写 server/eula.txt。先识别服务端包自带脚本，不盲目生成替代脚本。
- 客户端模组先扫描，再按证据重命名为 .jar.disabled，不删除。日志明确点名的模组可用 disable_server_mods。
- MCDR 用工作区内置 Python；插件依赖只按日志/requirements 安装并复查。所有成功结论必须有真实工具与日志证据。
`;

function publicSkill(row: typeof skills.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    path: row.path,
    enabled: Boolean(row.enabled),
    builtIn: Boolean(row.builtIn),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export class SkillService {
  async ensureBuiltInSkills() {
    const skillDir = path.join(appConfig.skillsDir, builtInSkillId);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), builtInSkillContent);
    await writeFile(path.join(skillDir, "skill.json"), JSON.stringify({ id: builtInSkillId, name: builtInSkillName, version: builtInSkillVersion }, null, 2));

    const existing = getDb().select().from(skills).where(eq(skills.id, builtInSkillId)).get();
    const now = nowIso();
    if (!existing) {
      getDb().insert(skills).values({
        id: builtInSkillId, name: builtInSkillName, description: builtInSkillDescription,
        version: builtInSkillVersion, path: skillDir, enabled: 1, builtIn: 1, createdAt: now, updatedAt: now
      }).run();
    } else {
      getDb().update(skills).set({
        name: builtInSkillName, description: builtInSkillDescription,
        version: builtInSkillVersion, path: skillDir, builtIn: 1, updatedAt: now
      }).where(eq(skills.id, builtInSkillId)).run();
    }
  }

  list() {
    return getDb().select().from(skills).all().map(publicSkill);
  }

  async getEnabledSkillContents() {
    const rows = getDb().select().from(skills).where(eq(skills.enabled, 1)).all();
    const contents: string[] = [];
    for (const row of rows) {
      const content = await readFile(path.join(row.path, "SKILL.md"), "utf8").catch(() => "");
      if (content.trim()) contents.push(`## ${row.name}\n\n${content.trim()}`);
    }
    return contents;
  }

  setEnabled(id: string, enabled: boolean) {
    getDb().update(skills).set({ enabled: enabled ? 1 : 0, updatedAt: nowIso() }).where(eq(skills.id, id)).run();
    const row = getDb().select().from(skills).where(eq(skills.id, id)).get();
    if (!row) throw new Error("Skill not found");
    return publicSkill(row);
  }
}
