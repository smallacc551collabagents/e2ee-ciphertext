// Validate Fastify request parts with the @e2ee/shared zod wire schemas (single source with the frontend).
// Failures surface as Fastify validation errors, so app.setErrorHandler maps them to
// 400 { error: "validation_error", message } exactly like the former JSON-schema validation.
import type { FastifySchema, FastifySchemaCompiler } from "fastify";

interface SafeParser { safeParse(d: unknown): { success: true; data: unknown } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } }

export const sharedValidator: FastifySchemaCompiler<unknown> = ({ schema, httpPart }) => (data: unknown) => {
  const r = (schema as SafeParser).safeParse(data);
  if (r.success) return { value: r.data };
  const i = r.error.issues[0];
  const where = [httpPart ?? "body", ...(i?.path ?? [])].join("/");
  const e = Object.assign(new Error(`${where} ${i?.message ?? "is invalid"}`), {
    validation: r.error.issues.map((x) => ({ instancePath: "/" + x.path.join("/"), message: x.message })),
  });
  return { error: e };
};

/** Route options: `schema` holds zod parsers from @e2ee/shared; compiled by sharedValidator. */
export const shared = (s: { body?: SafeParser; params?: SafeParser; querystring?: SafeParser }) =>
  ({ schema: s as unknown as FastifySchema, validatorCompiler: sharedValidator });
