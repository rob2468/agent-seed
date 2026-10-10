export type Call = { id: string; name: string; arguments: string };
export type Reply = { role: 'assistant'; content: string; calls: Call[] };
export type Message =
  | { role: 'system' | 'user'; content: string }
  | Reply
  | { role: 'tool'; callId: string; content: string };
export interface Model {
  reply(history: readonly Message[]): Promise<Reply>;
}
export type ToolResult =
  { ok: true; data: unknown } | { ok: false; error: string };
export type Execute = (call: Call) => Promise<ToolResult>;
