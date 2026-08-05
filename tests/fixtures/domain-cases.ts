export const domainCases = [
  {
    name: 'explicit domain normalization',
    input: { domain: [' One.Localhost ', 'two.localhost', '', 'one.localhost'] },
    expected: ['one.localhost', 'two.localhost'],
  },
  {
    name: 'default checkout domain',
    input: { repo: 'My Repo', branch: 'feature/editor' },
    expected: ['my-repo.feature-editor.localhost'],
  },
  {
    name: 'custom base domain normalization',
    input: { repo: 'app', branch: 'main', baseDomain: '.Local.Example.' },
    expected: ['app.main.local.example'],
  },
  {
    name: 'same branch instance label',
    input: { repo: 'app', branch: 'main', instanceLabel: 'Copy 2' },
    expected: ['app.main.copy-2.localhost'],
  },
  {
    name: 'localtest.me loopback',
    input: { repo: 'app', branch: 'main', loopbackDomain: 'localtest.me' },
    expected: ['app.main.localtest.me'],
  },
  {
    name: 'lvh.me loopback',
    input: { repo: 'app', branch: 'main', loopbackDomain: 'lvh.me' },
    expected: ['app.main.lvh.me'],
  },
  {
    name: 'nip.io loopback',
    input: { repo: 'app', branch: 'main', loopbackDomain: 'nip.io' },
    expected: ['app.main.127.0.0.1.nip.io'],
  },
] as const;
