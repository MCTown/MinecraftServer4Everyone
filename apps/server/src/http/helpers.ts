import { z } from "zod";

export const idParams = z.object({ id: z.string().min(1) });

export function parseBody<T>(schema: z.ZodSchema<T>, body: unknown) {
  return schema.parse(body);
}
