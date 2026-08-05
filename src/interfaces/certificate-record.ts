export interface CertificateAuthorityRecord {
  certificatePath: string;
  keyPath: string;
  fingerprint: string;
  fingerprintSha1: string;
  validFrom: string;
  validTo: string;
  expiresSoon: boolean;
}

export interface CertificateRecord {
  hostname: string;
  certificatePath: string;
  keyPath: string;
  chainPath: string;
  fingerprint: string;
  validTo: string;
  source: 'local-ca' | 'imported';
}
