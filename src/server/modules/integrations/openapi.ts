/**
 * OpenAPI 3.1 description of the public API (served at /api/v1/openapi.json and rendered on /developers).
 * Pure: a function of the workspace host.
 */
import { API_SCOPES, WEBHOOK_EVENTS } from "./rules";

const page = (item: string) => ({
  type: "object",
  properties: { data: { type: "array", items: { $ref: `#/components/schemas/${item}` } }, next_cursor: { type: ["string", "null"] }, has_more: { type: "boolean" } },
});
const list = (tag: string, scope: string, item: string, params: string[]) => ({
  get: {
    tags: [tag], summary: `List ${item.toLowerCase()}s`, security: [{ bearer: [scope] }],
    parameters: [...params.map((p) => ({ name: p, in: "query", schema: { type: "string" } })), { name: "limit", in: "query", schema: { type: "integer", maximum: 100, default: 50 } }, { name: "cursor", in: "query", schema: { type: "string" } }],
    responses: { "200": { description: "A page", content: { "application/json": { schema: page(item) } } }, "401": { $ref: "#/components/responses/Unauthenticated" }, "403": { $ref: "#/components/responses/Forbidden" } },
  },
});

export function openapiDocument(host: string) {
  const base = `${host.startsWith("localhost") || host.includes(".localhost") ? "http" : "https"}://${host}`;
  return {
    openapi: "3.1.0",
    info: { title: "erp public API", version: "1.0", description: "Directory, leave and attendance data for one workspace, plus leave requests, punches and Zapier-style REST hooks. Every request goes to the workspace's own address." },
    servers: [{ url: `${base}/api/v1` }],
    tags: [{ name: "Auth" }, { name: "Directory" }, { name: "Leave" }, { name: "Attendance" }, { name: "Hooks" }],
    paths: {
      "/../oauth/token": {
        post: {
          tags: ["Auth"], summary: "OAuth2 client credentials → access token", security: [],
          description: "POST application/x-www-form-urlencoded with grant_type=client_credentials and either HTTP Basic (client id : secret) or client_id + client_secret in the body. Optional scope (space separated, a subset of the client's scopes). Tokens last one hour.",
          responses: { "200": { description: "Token", content: { "application/json": { schema: { type: "object", properties: { access_token: { type: "string" }, token_type: { type: "string", const: "Bearer" }, expires_in: { type: "integer" }, scope: { type: "string" } } } } } }, "401": { description: "invalid_client" } },
        },
      },
      "/me": { get: { tags: ["Auth"], summary: "Who am I: the key's or token's scopes", security: [{ bearer: [] }], responses: { "200": { description: "Scopes and resources" } } } },
      "/employees": list("Directory", "employees:read", "Employee", ["status", "updated_since"]),
      "/departments": list("Directory", "departments:read", "Department", []),
      "/locations": list("Directory", "locations:read", "Location", []),
      "/leave-requests": {
        ...list("Leave", "leave:read", "LeaveRequest", ["employee_id", "status", "from", "to"]),
        post: {
          tags: ["Leave"], summary: "Apply for leave on someone's behalf", security: [{ bearer: ["leave:write"] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewLeaveRequest" } } } },
          responses: { "201": { description: "Created (status pending or approved)" }, "422": { description: "Policy violation (balance, notice, overlap …)" }, "404": { description: "Unknown person or leave type" } },
        },
      },
      "/attendance": list("Attendance", "attendance:read", "AttendanceDay", ["employee_id", "from", "to"]),
      "/attendance/punches": {
        post: {
          tags: ["Attendance"], summary: "Record a clock-in / clock-out", security: [{ bearer: ["attendance:write"] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewPunch" } } } },
          responses: { "201": { description: "Recorded (duplicate=true when external_id was seen before)" }, "422": { description: "Timestamp out of range" } },
        },
      },
      "/hooks": {
        get: { tags: ["Hooks"], summary: "List this key's / client's REST hooks", security: [{ bearer: ["hooks:write"] }], responses: { "200": { description: "Hooks" } } },
        post: {
          tags: ["Hooks"], summary: "Subscribe (Zapier REST hook)", security: [{ bearer: ["hooks:write"] }],
          description: "Body: { event, target_url }. Returns the hook id and a signing secret (once). Deliveries are POSTed with X-Erp-Signature (t=<unix>,v1=<hmac-sha256>) and retried with backoff.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["event", "target_url"], properties: { event: { type: "string", enum: WEBHOOK_EVENTS.filter((e) => e.key !== "test.ping").map((e) => e.key) }, target_url: { type: "string", format: "uri" } } } } } },
          responses: { "201": { description: "Subscribed" }, "200": { description: "Already subscribed" } },
        },
      },
      "/hooks/{id}": { delete: { tags: ["Hooks"], summary: "Unsubscribe", security: [{ bearer: ["hooks:write"] }], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "204": { description: "Removed" }, "404": { description: "No such hook" } } } },
      "/hooks/sample/{event}": { get: { tags: ["Hooks"], summary: "Sample payload for an event", security: [{ bearer: [] }], parameters: [{ name: "event", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Example delivery body" } } } },
      "/triggers/{event}": { get: { tags: ["Hooks"], summary: "Polling trigger: newest items for an event (newest first, stable ids)", security: [{ bearer: [] }], parameters: [{ name: "event", in: "path", required: true, schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", default: 25, maximum: 100 } }], responses: { "200": { description: "Items" } } } },
    },
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: `An API key (erp_live_…) or an OAuth2 access token. Scopes: ${API_SCOPES.map((s) => s.key).join(", ")}.` } },
      responses: { Unauthenticated: { description: "Missing or invalid credentials" }, Forbidden: { description: "The credential lacks the scope" } },
      schemas: {
        Employee: { type: "object", properties: { id: { type: "string" }, employee_number: { type: "string" }, display_name: { type: "string" }, work_email: { type: "string" }, status: { type: "string" }, joining_date: { type: "string" }, department: { type: ["string", "null"] }, designation: { type: ["string", "null"] }, location: { type: ["string", "null"] }, manager_id: { type: ["string", "null"] } } },
        Department: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, parent_id: { type: ["string", "null"] } } },
        Location: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, timezone: { type: ["string", "null"] } } },
        LeaveRequest: { type: "object", properties: { id: { type: "string" }, employee_id: { type: "string" }, leave_type_code: { type: "string" }, from_date: { type: "string" }, to_date: { type: "string" }, days: { type: "number" }, status: { type: "string" } } },
        AttendanceDay: { type: "object", properties: { id: { type: "string" }, employee_id: { type: "string" }, date: { type: "string" }, status: { type: "string" }, first_in: { type: ["string", "null"] }, last_out: { type: ["string", "null"] }, effective_minutes: { type: ["integer", "null"] } } },
        NewLeaveRequest: { type: "object", required: ["from"], properties: { employee_id: { type: "string" }, employee_number: { type: "string" }, leave_type_id: { type: "string" }, leave_type_code: { type: "string", example: "CL" }, from: { type: "string", format: "date" }, to: { type: "string", format: "date" }, from_part: { type: "string", enum: ["full", "first", "second"] }, to_part: { type: "string", enum: ["full", "first", "second"] }, note: { type: "string" } } },
        NewPunch: { type: "object", required: ["at"], properties: { employee_id: { type: "string" }, employee_number: { type: "string" }, at: { type: "string", format: "date-time" }, direction: { type: "string", enum: ["in", "out", "auto"] }, external_id: { type: "string", description: "Idempotency key per person" }, comment: { type: "string" } } },
      },
    },
  };
}
