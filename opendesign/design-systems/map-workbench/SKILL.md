# Map Workbench

Use this system for the MCA map inspector and any future map maintenance surface in Minecraft Server 4 Everyone.

## Rules

- Preserve the host console's graphitic palette and IBM Plex Mono data treatment.
- Use cyan for inspected/selected data, amber for prerequisites and confirmation, red only for destructive or corrupt states.
- Keep the preview canvas unframed within the main work area; frame only repeated region items, the operation rail and snapshot entries.
- Show server state and snapshot state beside every mutation control.
- Use 44px touch targets on mobile, focus traps in dialogs and visible non-color status labels.
- Never expose delete or rollback as a one-click action. Require a stopped server, an impact summary, an automatic or explicitly selected snapshot, and a typed confirmation phrase.

## Interaction pattern

1. Inspect a region or chunk.
2. Select the smallest useful scope.
3. Show the affected files and server-state gate.
4. Create or choose a snapshot.
5. Require a typed phrase matching the exact operation.
6. Execute with progress and offer rollback from the resulting snapshot.
