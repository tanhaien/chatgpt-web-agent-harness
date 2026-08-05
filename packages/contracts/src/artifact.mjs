import { assertObject, assertString } from "./common.mjs";

export function validateArtifactRef(input) {
  const value = assertObject(input, "artifact");
  assertString(value.id, "artifact.id");
  assertString(value.kind, "artifact.kind");
  assertString(value.uri, "artifact.uri");
  assertString(value.createdAt, "artifact.createdAt");
  if (value.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(value.sha256)) {
    throw new TypeError("artifact.sha256 must be a 64-character hexadecimal digest");
  }
  return value;
}
