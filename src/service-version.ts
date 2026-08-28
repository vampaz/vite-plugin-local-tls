interface ParsedServiceVersion {
  core: [number, number, number];
  prerelease: string[] | null;
}

function parseServiceVersion(version: string): ParsedServiceVersion | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) {
    return null;
  }
  const core = match.slice(1, 4).map(Number) as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) {
    return null;
  }
  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some((identifier) => /^0\d+$/.test(identifier))) {
    return null;
  }
  return { core, prerelease };
}

function comparePrereleaseIdentifier(left: string, right: string): -1 | 0 | 1 {
  const leftNumeric = /^(0|[1-9]\d*)$/.test(left);
  const rightNumeric = /^(0|[1-9]\d*)$/.test(right);
  if (leftNumeric && rightNumeric) {
    if (left.length !== right.length) {
      return left.length < right.length ? -1 : 1;
    }
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function comparePrerelease(left: string[] | null, right: string[] | null): -1 | 0 | 1 {
  if (!left || !right) {
    return left === right ? 0 : left ? -1 : 1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

export function compareServiceVersions(left: string, right: string): -1 | 0 | 1 | null {
  const parsedLeft = parseServiceVersion(left);
  const parsedRight = parseServiceVersion(right);
  if (!parsedLeft || !parsedRight) {
    return null;
  }
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    const leftPart = parsedLeft.core[index]!;
    const rightPart = parsedRight.core[index]!;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}
