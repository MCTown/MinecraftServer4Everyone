import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { appConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { skills } from "../db/schema.js";
import { nowIso } from "../utils/time.js";

const builtInSkillId = "minecraft_deploy";
const builtInSkillName = "服务端部署 Skill";
const builtInSkillVersion = "1.17.0";
const builtInSkillDescription = "自动套用模板后的整合包安装、Java 版本依赖检查、MCDReforged 配置、启动脚本生成和常见问题检查。";
const builtInSkillContent = `# 服务端部署 Skill

完整部署调用 begin_deployment_workflow，技术步骤以「当前部署流程」为准；普通查询和排错不启动完整流程。
优先专用工具，Shell 用于补充检查和修复。合并独立的文件检查，复用已有成功证据，不重复安装或核验。
仅在日志指向客户端模组时扫描并按证据禁用（重命名 .jar.disabled，不删除）。单个模组用 download_mod_to_server_mods。
平台凭据缺失时报告缺少的凭据，不猜测。所有成功结论须有工具结果或日志依据。
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
