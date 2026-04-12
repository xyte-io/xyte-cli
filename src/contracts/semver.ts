const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(value: string): ParsedSemver | undefined {
  const match = value.trim().match(SEMVER_RE);
  if (!match) {
    return undefined;
  }
  const prerelease = match[4] ? match[4].split('.').filter(Boolean) : [];
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  const maxLength = Math.max(a.length, b.length);
  for (let index = 0; index < maxLength; index += 1) {
    const aPart = a[index];
    const bPart = b[index];
    if (aPart === undefined) {
      return -1;
    }
    if (bPart === undefined) {
      return 1;
    }

    const aNumber = Number.parseInt(aPart, 10);
    const bNumber = Number.parseInt(bPart, 10);
    const aIsNumber = Number.isFinite(aNumber) && String(aNumber) === aPart;
    const bIsNumber = Number.isFinite(bNumber) && String(bNumber) === bPart;

    if (aIsNumber && bIsNumber) {
      if (aNumber !== bNumber) {
        return aNumber > bNumber ? 1 : -1;
      }
      continue;
    }

    if (aIsNumber && !bIsNumber) {
      return -1;
    }
    if (!aIsNumber && bIsNumber) {
      return 1;
    }

    if (aPart !== bPart) {
      return aPart > bPart ? 1 : -1;
    }
  }
  return 0;
}

export function compareSemver(a: string, b: string): number {
  const aParsed = parseSemver(a);
  const bParsed = parseSemver(b);
  if (!aParsed || !bParsed) {
    return a === b ? 0 : a > b ? 1 : -1;
  }

  if (aParsed.major !== bParsed.major) {
    return aParsed.major > bParsed.major ? 1 : -1;
  }
  if (aParsed.minor !== bParsed.minor) {
    return aParsed.minor > bParsed.minor ? 1 : -1;
  }
  if (aParsed.patch !== bParsed.patch) {
    return aParsed.patch > bParsed.patch ? 1 : -1;
  }

  if (aParsed.prerelease.length === 0 && bParsed.prerelease.length === 0) {
    return 0;
  }
  if (aParsed.prerelease.length === 0) {
    return 1;
  }
  if (bParsed.prerelease.length === 0) {
    return -1;
  }
  return comparePrerelease(aParsed.prerelease, bParsed.prerelease);
}
