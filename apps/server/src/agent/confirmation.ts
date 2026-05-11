import type { AgentConfirmationRequest } from "../types.js";

export class AgentConfirmationError extends Error {
  readonly code = "AGENT_CONFIRMATION_REQUIRED";

  constructor(readonly request: AgentConfirmationRequest) {
    super("Agent operation requires user confirmation");
  }
}
