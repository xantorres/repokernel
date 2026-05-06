/**
 * Allowlisted env passed to `gh` subprocesses. The intent is to refuse to
 * inherit arbitrary parent env (which may carry secrets unrelated to GitHub
 * auth), while keeping the set of vars that gh and its underlying network
 * stack legitimately need on every supported platform.
 *
 * Categories:
 *  - Path/home resolution: PATH, HOME, USERPROFILE, APPDATA, LOCALAPPDATA,
 *    HOMEDRIVE, HOMEPATH, XDG_*.
 *  - gh auth + host config: GH_TOKEN, GITHUB_TOKEN, GH_HOST,
 *    GH_ENTERPRISE_TOKEN, GHE_TOKEN.
 *  - Locale (so non-ASCII titles/comments parse correctly): LANG, LC_ALL.
 *  - Temp dirs (gh writes auth cache via os.TempDir): TMPDIR, TMP, TEMP.
 *  - TLS / corporate CA bundles: SSL_CERT_FILE, SSL_CERT_DIR,
 *    NODE_EXTRA_CA_CERTS, CURL_CA_BUNDLE, REQUESTS_CA_BUNDLE.
 *  - Proxy: HTTP_PROXY, HTTPS_PROXY, NO_PROXY, ALL_PROXY.
 *  - gh UX hygiene: GH_NO_UPDATE_NOTIFIER, GH_PAGER (so a pager doesn't block
 *    subprocess stdout in CI).
 *
 * Deliberately excluded: SSH_AUTH_SOCK / SSH_AGENT_PID. Forwarding the SSH
 * agent into a gh subprocess broadens the trust boundary unnecessarily — gh
 * uses HTTPS + token auth for API calls and does not need agent forwarding
 * for its core flows.
 */
const GH_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'GH_ENTERPRISE_TOKEN',
  'GHE_TOKEN',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'NO_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'GH_NO_UPDATE_NOTIFIER',
  'GH_PAGER',
] as const;

export function ghEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    GH_ENV_ALLOWLIST.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}
