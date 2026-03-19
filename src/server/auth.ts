export function validateAuth(header: string | undefined, expectedToken: string): boolean {
  if (expectedToken.length === 0) {
    return true;
  }

  if (!header) {
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return false;
  }

  return match[1] === expectedToken;
}