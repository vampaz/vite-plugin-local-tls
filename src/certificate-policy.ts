export type CertificatePolicy = 'local-ca' | 'imported';

export function isLocalAutomationHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'localtest.me' ||
    hostname.endsWith('.localtest.me') ||
    hostname === 'lvh.me' ||
    hostname.endsWith('.lvh.me') ||
    hostname.endsWith('.nip.io')
  );
}

export function resolveCertificatePolicy(
  hostname: string,
  internalTls: boolean | undefined,
  hasImportedCertificate = false,
): CertificatePolicy {
  if (internalTls !== false || isLocalAutomationHostname(hostname)) {
    return 'local-ca';
  }
  if (hasImportedCertificate) {
    return 'imported';
  }
  throw new Error(
    `No imported certificate is available for ${hostname}. Run \`vite-local-tls cert import --hostname ${hostname} --cert <path> --key <path>\`.`,
  );
}
