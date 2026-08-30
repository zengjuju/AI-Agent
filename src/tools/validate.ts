type CheckResult = { ok: true } | { ok: false; error: string };

export type ValidArgsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function validateArgs(args: unknown, schema: Record<string, unknown>): ValidArgsResult {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, error: 'arguments must be a JSON object' };
  }

  const obj = args as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  for (const key of required) {
    if (!(key in obj)) {
      return { ok: false, error: `missing required argument "${key}"` };
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    const propSchema = properties[key];
    if (!propSchema) {
      return { ok: false, error: `unknown argument "${key}"` };
    }
    const check = checkJsonValue(value, propSchema);
    if (!check.ok) {
      return { ok: false, error: `invalid argument "${key}": ${check.error}` };
    }
  }

  return { ok: true, value: obj };
}

function checkJsonValue(value: unknown, schema: Record<string, unknown>): CheckResult {
  const type = schema.type;
  if (type === 'string') {
    return typeof value === 'string' ? ok() : fail(`expected string, got ${typeof value}`);
  }
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
      ? ok()
      : fail(`expected number, got ${typeof value}`);
  }
  if (type === 'integer') {
    return typeof value === 'number' && Number.isInteger(value)
      ? ok()
      : fail(`expected integer, got ${JSON.stringify(value)}`);
  }
  if (type === 'boolean') {
    return typeof value === 'boolean' ? ok() : fail(`expected boolean, got ${typeof value}`);
  }
  if (type === 'array') {
    return Array.isArray(value) ? ok() : fail('expected array');
  }
  if (type === 'object') {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? ok()
      : fail('expected object');
  }
  return ok();
}

function ok(): CheckResult {
  return { ok: true };
}

function fail(error: string): CheckResult {
  return { ok: false, error };
}
