declare const __VITE_LOCAL_TLS_PACKAGE_VERSION__: string;

export const PACKAGE_VERSION =
  typeof __VITE_LOCAL_TLS_PACKAGE_VERSION__ === 'string'
    ? __VITE_LOCAL_TLS_PACKAGE_VERSION__
    : '0.0.0-development';
