import type { AgentQuestionAnswer, AgentQuestionInput, AgentQuestionRequest } from "../types.js";
import { createId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

/** Questions are blocking and never auto-approved; abort/restart cannot invent an answer. */
export class QuestionBroker {
  private pending = new Map<string, { request: AgentQuestionRequest; finish: (answer: AgentQuestionAnswer) => void }>();

  get(scopeId: string) {
    return this.pending.get(scopeId)?.request ?? null;
  }

  ask(scopeId: string, input: AgentQuestionInput, signal: AbortSignal): Promise<AgentQuestionAnswer> {
    if (signal.aborted) return Promise.resolve({ status: "cancelled", selected: [] });
    if (this.pending.has(scopeId)) throw new Error("请先完成当前选择题");
    const request = { ...input, id: createId("question"), serverId: scopeId, createdAt: nowIso() };
    return new Promise((resolve) => {
      const abort = () => finish({ status: "cancelled", selected: [] });
      const finish = (answer: AgentQuestionAnswer) => {
        signal.removeEventListener("abort", abort);
        this.pending.delete(scopeId);
        resolve(answer);
      };
      this.pending.set(scopeId, { request, finish });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  answer(scopeId: string, questionId: string, selected: string[], cancelled = false) {
    const pending = this.pending.get(scopeId);
    if (!pending || pending.request.id !== questionId) throw new Error("问题已失效或不属于当前会话");
    if (!cancelled) {
      if (!selected.length || (!pending.request.multiple && selected.length !== 1)
        || new Set(selected).size !== selected.length
        || selected.some((label) => !pending.request.options.some((option) => option.label === label))) {
        throw new Error("请选择有效选项；单选题只能选择一项");
      }
    }
    pending.finish({ status: cancelled ? "cancelled" : "answered", selected: cancelled ? [] : selected });
    return { ok: true };
  }

  cancel(scopeId: string) {
    this.pending.get(scopeId)?.finish({ status: "cancelled", selected: [] });
  }
}
