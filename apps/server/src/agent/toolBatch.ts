/** Only observational calls overlap by default. Mutations, approvals and workflow
 * controls are barriers: arbitrary shell/config writes cannot safely be inferred
 * independent from a model's function-call array. Background jobs opt in separately. */
const concurrentReads = new Set([
  "list_server_files", "read_server_text_file", "get_current_server_config", "inspect_current_server_validation",
  "check_java_environment", "list_uploaded_files", "inspect_mrpack_server_slot", "get_server_slot_status",
  "web_search", "fetch_web_page", "list_instances", "get_instance_console",
  "search_modrinth_modpacks", "list_modrinth_modpack_versions", "fetch_https_resource_summary"
]);

export async function runToolBatch<T, R>(calls: readonly T[], name: (call: T) => string,
  execute: (call: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < calls.length;) {
    if (!concurrentReads.has(name(calls[index]!))) {
      output.push(await execute(calls[index++]!));
      continue;
    }
    const start = index;
    // Bound fanout; settle every sibling before surfacing an error or releasing ownership.
    while (index < calls.length && index - start < 8 && concurrentReads.has(name(calls[index]!))) index++;
    const results = await Promise.allSettled(calls.slice(start, index).map(execute));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      output.push(result.value);
    }
  }
  return output;
}
