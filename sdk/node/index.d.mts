export type Dialect = "chat" | "responses" | "messages";
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };

export class UnsupportedRequest extends Error {}
export class CallError extends Error { readonly status: number; constructor(status: number); }

export interface ClientOptions {
  url: string;
  key: string;
  cachePath: string;
  localTargets(selector: string, dialect: Dialect): string[];
  shouldTryNext?(error: Error, target: string): boolean;
  isGatewayUnavailable?(error: CallError): boolean;
  streamIdleTimeoutMs?: number;
}

export interface CallResult { data: JSONObject; source: "gateway" | "direct"; target?: string; }
export interface StreamEvent { event: string; data: JSONObject | "[DONE]"; }
export interface StreamResult {
  source: "gateway" | "direct";
  target?: string;
  events: AsyncIterable<StreamEvent>;
  cancel(): void;
}

export class Client {
  constructor(options: ClientOptions);
  load(): Promise<Client>;
  refresh(): Promise<JSONObject>;
  call(dialect: Dialect, selector: string, body: JSONObject): Promise<JSONObject>;
  callWithInfo(dialect: Dialect, selector: string, body: JSONObject): Promise<CallResult>;
  stream(dialect: Dialect, selector: string, body: JSONObject): Promise<StreamResult>;
}
