export const RISK_LEVELS = Object.freeze(["read", "safe-write", "risky", "critical"]);
export const RUN_STATUSES = Object.freeze([
  "created", "queued", "running", "waiting", "verifying",
  "completed", "blocked", "failed", "cancelled"
]);

export function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

export function assertString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

export function assertEnum(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

export function assertStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`${name} must be an array of non-empty strings`);
  }
  return value;
}

export function assertIsoString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (isNaN(new Date(value).getTime())) {
    throw new TypeError(`${name} must be a valid ISO date-time string`);
  }
  return value;
}

export function nowIso() {
  return new Date().toISOString();
}
