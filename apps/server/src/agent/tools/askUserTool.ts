import { z } from "zod";
import { objectSchema, stringProperty, type AgentTool, type AgentToolContext } from "../toolKit.js";

export const questionInputSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  multiple: z.boolean().default(false),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000).optional()
  })).min(2).max(20)
}).refine((input) => new Set(input.options.map((option) => option.label)).size === input.options.length, "选项名称不能重复");

export function createAskUserTool(ctx: AgentToolContext): AgentTool {
  return {
    definition: {
      type: "function",
      function: {
        name: "ask_user",
        description: "需要用户决定方案或补充偏好时，向用户提出一道单选或多选题。等待用户提交后返回真实选择，不得替用户回答。multiple=true 表示多选，否则必须单选；用户可取消。不用于代替危险操作确认。",
        parameters: objectSchema({
          question: { type: "string", description: "向用户提出的问题" },
          multiple: { type: "boolean", description: "是否允许多选，默认 false" },
          options: { type: "array", minItems: 2, maxItems: 20, items: objectSchema({ label: stringProperty, description: stringProperty }, ["label"]) }
        }, ["question", "options"])
      }
    },
    execute: async (input) => {
      const question = questionInputSchema.parse(input);
      if (!ctx.askUser) throw new Error("当前环境不支持用户选择题");
      return JSON.stringify(await ctx.askUser(question));
    }
  };
}
