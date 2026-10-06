import type { components, operations, paths, webhooks } from "./generated/openapi.js";

export type { components, operations, paths, webhooks };

/** A component schema by name, e.g. `Schema<"TaskStatusResponse">`. */
export type Schema<N extends keyof components["schemas"]> = components["schemas"][N];

type JsonBody<T> = T extends { content: { "application/json": infer B } } ? B : never;

/** The JSON request body of an operation, e.g. `OperationBody<"video_kling_3_t2v">`. */
export type OperationBody<Op extends keyof operations> = operations[Op] extends { requestBody?: infer R } ? JsonBody<NonNullable<R>> : never;

/** The JSON body an operation answers with a given status, e.g. `OperationResponse<"tasks_get", 200>`. */
export type OperationResponse<Op extends keyof operations, S extends number = 200> = operations[Op] extends { responses: infer R }
  ? S extends keyof R
    ? JsonBody<R[S]>
    : never
  : never;

export type TaskStatus = Schema<"TaskStatusResponse">;
export type AsyncTaskAccepted = Schema<"AsyncTaskAccepted">;
export type ModelDetail = Schema<"ModelDetail">;
export type ModelRow = Schema<"ModelRow">;
export type ModelEndpoint = Schema<"ModelEndpoint">;
export type FileObject = Schema<"FileResponse">;
export type WorkflowRunState = Schema<"WorkflowRunState">;
export type Mode = "auto" | "direct" | "opengpu";
