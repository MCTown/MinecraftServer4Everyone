import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { appConfig } from "../config.js";
import { getDb } from "../db/client.js";
import { skills } from "../db/schema.js";
import { nowIso } from "../utils/time.js";

const builtInSkillId = "minecraft_deploy";
const builtInSkillName = "服务端部署 Skill";
const builtInSkillVersion = "1.2.2";
const builtInSkillDescription = "服务端初始化、新整合包安装、Java 检查、模板生成、配置修改、启动脚本生成和常见问题检查。";
const builtInSkillContent = `# 服务端部署 Skill

用于初始化 Minecraft 服务端、安装新整合包、检查 Java、生成模板、修改配置、生成启动参数和排查常见问题。

## 安装新整合包流程

### 确定服务端

首先通过附件或者用户输入确定服务端的名字，根据服务端的名字，从 CurseForge 或 Modrinth 查找这个整合包，确认安装流程和注意事项。

接下来，查看附件，判断用户是否附上了可用的服务端文件。

如果已附上可用服务端文件，结合之前搜索到的信息，使用该服务端进行部署。

如果没有可用服务端文件，通过相关网站寻找并下载服务端文件；如果无法获得这个服务端的下载文件，向用户索要。

### 下载 CurseForge 整合包服务端

当用户要求下载某个 CurseForge 整合包的服务端时，先搜索并进入该整合包的 CurseForge 页面，打开 Files，查找 Server Pack、Server Files 或名称中带 server 的附加文件。

找到后，提取 Project ID 和服务端文件的 File ID，使用如下链接下载：

\`https://www.curseforge.com/api/v1/mods/ProjectID/files/FileID/download\`

如果该链接下载返回 403，不要反复重试原链接，直接改用 ForgeCDN 最终文件链接下载。构造规则：把 File ID 的最后三位作为第二段，其余前缀作为第一段，文件名使用 CurseForge 文件列表中的精确文件名并进行 URL 编码。

格式：

\`https://mediafilez.forgecdn.net/files/FileID前缀/FileID后三位/文件名\`

示例：File ID 为 \`7097957\`，文件名为 \`Server-Files-1.1.1.zip\`，最终 CDN 链接为：

\`https://mediafilez.forgecdn.net/files/7097/957/Server-Files-1.1.1.zip\`

### 部署服务端

1. 确认服务端应该使用的 Java 版本；如果缺少相应 Java 版本，进行安装。
2. 根据模板部署服务端。当前模板基于 MCDReforged，应该把服务端放到 server/ 目录下，并编辑 MCDReforged 配置文件 config.yml，使 start_command 启动指令和 handler 解析方式符合该服务端。
3. 在首次启动前，必须在真正的 Minecraft 服务端工作目录下创建或更新 \`eula.txt\`，内容至少包含 \`eula=true\`。不要等待服务端在终端里询问 EULA，也不要尝试通过交互输入回答 \`true\`；Agent 无法可靠处理这类交互，必须通过文件预先完成。
4. 所有启动命令都必须使用非交互方式：Minecraft 服务端启动参数包含 \`nogui\`；不要运行会停在 stdin 提示、菜单、确认问题或 TUI 界面的命令。如果命令需要确认参数或配置文件，先写入文件或使用非交互参数解决。
5. 尝试通过 MCDReforged 启动服务端，运行指令为 \`python -m mcdreforged\`。
6. 检查服务端是否完成启动；如果日志显示 \`Failed to load eula.txt\`、\`By answering 'true' to this prompt\` 或 \`You need to agree to the EULA\`，停止等待交互，立即写入正确位置的 \`eula.txt\` 后重新启动。
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
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      builtInSkillContent
    );
    await writeFile(
      path.join(skillDir, "skill.json"),
      JSON.stringify({ id: builtInSkillId, name: builtInSkillName, version: builtInSkillVersion }, null, 2)
    );

    const existing = getDb().select().from(skills).where(eq(skills.id, builtInSkillId)).get();
    const now = nowIso();
    if (!existing) {
      getDb().insert(skills).values({
        id: builtInSkillId,
        name: builtInSkillName,
        description: builtInSkillDescription,
        version: builtInSkillVersion,
        path: skillDir,
        enabled: 1,
        builtIn: 1,
        createdAt: now,
        updatedAt: now
      }).run();
    } else {
      getDb().update(skills).set({
        name: builtInSkillName,
        description: builtInSkillDescription,
        version: builtInSkillVersion,
        path: skillDir,
        builtIn: 1,
        updatedAt: now
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
      if (content.trim()) {
        contents.push(`## ${row.name}\n\n${content.trim()}`);
      }
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
