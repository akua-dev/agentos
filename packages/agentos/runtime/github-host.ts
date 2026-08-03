const DnsOrIpv4Pattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export function isValidGitHubHost(value: string): boolean {
  if (value !== value.toLowerCase()) return false;
  const separator = value.lastIndexOf(":");
  const hasPort = separator >= 0;
  const hostname = hasPort ? value.slice(0, separator) : value;
  const portSource = hasPort ? value.slice(separator + 1) : undefined;
  if (
    hostname.length === 0 || hostname.length > 253 ||
    !DnsOrIpv4Pattern.test(hostname)
  ) return false;
  if (portSource === undefined) return true;
  if (!/^[1-9][0-9]{0,4}$/.test(portSource)) return false;
  return Number(portSource) <= 65_535;
}
