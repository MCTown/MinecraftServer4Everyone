# 安装新整合包流程

## 确定服务端
首先通过附件或者用户输入确定服务端的名字，根据服务端的名字，从 curseforge 或 modrinth 找一下这个整合包，看看安装的流程和注意事项是什么。

确认整合包来源时必须同时考虑 Modrinth 和 CurseForge。只查询了其中一个平台、或其中一个平台结果不唯一/不匹配时，不要把 `identify_modpack` 标记为 `failed`，必须继续尝试另一个平台的官方 API 工具。只有两个平台都已查询且没有匹配项，或 CurseForge 因缺少/鉴权失败 API Key 需要用户配置，或用户没有提供足够名称/版本信息时，才可以失败并明确说明还缺少什么。

接下来，查看附件，用户是否附上了可用的服务端。

如果是，结合之前搜索到的信息，使用该服务端进行部署。

如果否，优先调用平台 API 工具获取服务端包：Modrinth 使用 `download_modrinth_server_pack_to_server_slot`，CurseForge 使用 `download_curseforge_server_pack_to_server_slot`。不要抓取 CurseForge 网页文件列表。CurseForge API 需要 CurseForge API Key；如果工具提示缺少或鉴权失败，或前端提示 `tool_config_required`，立即停止部署并让用户点击 Tools 卡片/设置中的配置按钮填写 API Key，申请/管理地址：`https://console.curseforge.com/?#/api-keys`。Modrinth 通常不需要 API Key；如果工具提示需要 PAT，立即停止部署并让用户点击配置按钮填写 PAT，申请/管理地址：`https://modrinth.com/settings/pats`。如果仍无法获得服务端包，向用户索要。

## 安装单个模组
当用户要求安装单个模组时，优先调用 `download_mod_to_server_mods`。该工具使用 Modrinth 或 CurseForge 官方 API 查找模组，并只会把 `.jar` 文件下载到当前服务端的 `server/mods/`。不要把 `.mrpack`、zip 服务端包或客户端整合包当作单个模组安装。CurseForge 来源需要先配置 CurseForge API Key；Modrinth PAT 可选，但如果工具提示需要 PAT，应停止并让用户点击配置按钮。

## 下载 CurseForge 整合包服务端
当用户要求下载某个 CurseForge 整合包的服务端时，优先调用 `download_curseforge_server_pack_to_server_slot`，不要抓取 CurseForge 网页 Files 页面。该工具会使用官方 API 搜索项目、文件和 Server Pack 并下载到服务端槽位。

找到后，提取 Project ID 和服务端文件的 File ID，使用如下链接下载：

`https://www.curseforge.com/api/v1/mods/ProjectID/files/FileID/download`

如果该链接下载返回 403，不要反复重试原链接，直接改用 ForgeCDN 最终文件链接下载。构造规则：把 File ID 的最后三位作为第二段，其余前缀作为第一段，文件名使用 CurseForge 文件列表中的精确文件名并进行 URL 编码。

格式：

`https://mediafilez.forgecdn.net/files/FileID前缀/FileID后三位/文件名`

示例：File ID 为 `7097957`，文件名为 `Server-Files-1.1.1.zip`，最终 CDN 链接为：

`https://mediafilez.forgecdn.net/files/7097/957/Server-Files-1.1.1.zip`

## 部署服务端
1. 确认服务端应该使用的 Java 版本，如果缺少相应 Java 版本，进行安装。
2. 必须调用 `initialize_server_template` 并使用 `template=reference` 套用项目内置 MCDReforged 模板。模板来自项目内置 `templates/reference`，会在当前服务端根目录放置 MCDReforged 的 `config.yml`、`permission.yml`、`plugins/`、`config/`、`logs/` 和 `server/`。
3. Minecraft 服务端本体必须放在 `server/` 目录下。服务端槽位中的 zip/tar.gz/tgz 必须用 `extract_server_slot_to_workspace` 解压到 `server`；不要解压到根目录，不要把 `mods`、`libraries`、`world`、`server.jar` 等 Minecraft 服务端文件放在 MCDReforged 根目录。
4. 直启验证成功后，必须调用 `configure_builtin_python_environment` 配置工作区内置 Python、pip 与 MCDReforged；不要直接使用系统 Python。Linux 下系统 python3 只允许用于创建 `workspace/python` venv，后续必须使用工作区 Python。
5. 编辑 MCDReforged 根目录 `config.yml`：`working_directory` 必须保持 `server`；`start_command` 必须是从 `server/` 工作目录可执行的非交互启动命令；`handler` 必须符合服务端核心/Loader。配置完成后调用 `update_current_server_config` 设置 `serverType=mcdreforged`，让 `start_current_server` 通过工作区内置 Python 执行 `-m mcdreforged` 启动模板根目录。
6. 在首次启动前，必须在真正的 Minecraft 服务端工作目录 `server/` 下创建或更新 `eula.txt`，内容至少包含 `eula=true`。不要等待服务端在终端里询问 EULA，也不要尝试通过交互输入回答 `true`；Agent 无法可靠处理这类交互，必须通过文件预先完成。
7. 所有启动命令都必须使用非交互方式：Minecraft 服务端启动参数包含 `nogui`；不要运行会停在 stdin 提示、菜单、确认问题或 TUI 界面的命令。如果命令需要确认参数或配置文件，先写入文件或使用非交互参数解决。
8. 直启验证应在 `server/` 内完成；最终验证必须通过 MCDReforged 启动服务端，并由后端使用工作区内置 Python 执行 `-m mcdreforged`。
9. 检查服务端是否完成启动；如果日志显示 `Failed to load eula.txt`、`By answering 'true' to this prompt` 或 `You need to agree to the EULA`，停止等待交互，立即写入 `server/eula.txt` 后重新启动。
