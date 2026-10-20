// Fill the SSH target with the current client IP while keeping an explicit user prefix.
export function fillRemoteHost(remote: string, ip: string): string {
  const trimmed = remote.trim();
  const at = trimmed.indexOf("@");
  return at > 0 ? `${trimmed.slice(0, at + 1)}${ip}` : ip;
}
