# Map Workbench Design System

独立地图工作台设计系统，建立在现有 Agent Console 的深色石墨视觉基础上，服务于 MCA 区块预览、结构诊断、快照和高危变更流程。

## Sources

- `apps/web/assets/css/layout/command-bridge.css`
- `apps/web/assets/css/components/dialogs.css`
- `apps/web/components/dialogs/MapEditorDialog.vue`
- `apps/web/components/workspace/InstanceTopbar.vue`

## Visual direction

- Neutral graphite surfaces keep large map data visually quiet.
- Cyan is reserved for inspected data, selected regions and safe navigation.
- Amber is reserved for stopped-server requirements, snapshot readiness and pending confirmation.
- Red is reserved for irreversible delete/rollback warnings and invalid MCA allocation diagnostics.
- Map cells are flat, square and information-dense. No decorative gradients, glows or ornamental cards.
- The workspace uses a wide preview plane, a narrow operational rail and a separate snapshot drawer.

## Type and content

- `IBM Plex Mono` carries coordinates, paths, timestamps, sector values and confirmation phrases.
- `DM Sans` carries headings and operational copy when the host app already loads it.
- Chinese labels use sentence-style phrasing. Buttons state the action and scope: `删除选定区块`, `回滚此快照`.
- High-risk actions always state server status, snapshot status, affected file count and the exact confirmation phrase.

## Index

- Tokens: `tokens/colors_and_type.css`
- Portable guidance: `SKILL.md`
