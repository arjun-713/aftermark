export type Outcome = {
  id: string;
  name: string;
  operation: "github.issue.create" | "hubspot.contact.update" | "custom";
  required: boolean;
  source: "github" | "hubspot" | "customer_verifier";
  resource: { id?: string; repository?: string; toolResultField?: string };
  assertions: Record<string, string | number | boolean | null>;
  observationWindowSeconds: number;
};
export type AgentEvent = {
  schemaVersion: "1.0";
  eventId: string;
  runId: string;
  spanId?: string;
  parentSpanId?: string;
  kind:
    | "run.started"
    | "run.completed"
    | "run.failed"
    | "run.cancelled"
    | "span.started"
    | "span.completed"
    | "tool.called"
    | "tool.result"
    | "outcome.expected"
    | "message";
  timestamp: string;
  agentVersion: string;
  environment: "production" | "staging" | "test";
  payload: {
    agent?: string;
    name?: string;
    text?: string;
    success?: boolean;
    toolCallId?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    result?: Record<string, unknown>;
    outcome?: Outcome;
    metadata?: Record<string, unknown>;
  };
};
