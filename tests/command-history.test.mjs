import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  CommandHistoryStore,
  extractBracketedPastePayload,
  extractNextSuggestionWord,
  looksSensitiveCommand,
  normalizeHistoryTimestampMs,
  rankGhostSuggestion,
  stripShellPrompt,
} from '../src/lib/commandHistory.ts';

test('extractBracketedPastePayload unwraps single-chunk, trailing-newline, multi-line, and chunked pastes', () => {
  // Non-paste inputs are ignored
  assert.deepEqual(extractBracketedPastePayload('\x1b[A', false), {
    handled: false,
    text: '',
    inPaste: false,
  });
  assert.deepEqual(extractBracketedPastePayload('ls -la', false), {
    handled: false,
    text: '',
    inPaste: false,
  });

  // Single-chunk bracketed paste without newline
  assert.deepEqual(
    extractBracketedPastePayload(`${BRACKETED_PASTE_START}docker compose up -d${BRACKETED_PASTE_END}`, false),
    { handled: true, text: 'docker compose up -d', inPaste: false },
  );

  // Bracketed paste with trailing newline + multi-line block
  assert.deepEqual(
    extractBracketedPastePayload(`${BRACKETED_PASTE_START}cd /srv/app\ngit pull\npm2 restart all\r\n${BRACKETED_PASTE_END}`, false),
    { handled: true, text: 'cd /srv/app\ngit pull\npm2 restart all\r\n', inPaste: false },
  );

  // Chunked bracketed paste across multiple onData events
  const c1 = extractBracketedPastePayload(`${BRACKETED_PASTE_START}kubectl logs `, false);
  assert.deepEqual(c1, { handled: true, text: 'kubectl logs ', inPaste: true });
  const c2 = extractBracketedPastePayload(`-f deploy/api${BRACKETED_PASTE_END}`, c1.inPaste);
  assert.deepEqual(c2, { handled: true, text: '-f deploy/api', inPaste: false });

  // Interrupted paste cleared cleanly on Ctrl+C
  const aborted = extractBracketedPastePayload('partial\x03', true);
  assert.deepEqual(aborted, { handled: true, text: 'partial\x03', inPaste: false });
});

test('looksSensitiveCommand blocks credentials and tokens while allowing normal commands', () => {
  assert.equal(looksSensitiveCommand('export API_KEY=sk-12345'), true);
  assert.equal(looksSensitiveCommand('curl -H "Authorization: Bearer abc" https://api.test'), true);
  assert.equal(looksSensitiveCommand('mysql -u root --password=secret'), true);
  assert.equal(looksSensitiveCommand('git clone https://ghp_abcdef123456@github.com/org/repo'), true);
  assert.equal(looksSensitiveCommand('-----BEGIN OPENSSH PRIVATE KEY-----'), true);

  assert.equal(looksSensitiveCommand('docker compose logs -f --tail=100'), false);
  assert.equal(looksSensitiveCommand('git status'), false);
  assert.equal(looksSensitiveCommand('systemctl restart nginx'), false);
});

test('stripShellPrompt recognizes standard, Starship/OMZ, box-drawing, PowerShell, and PS2 prompts', () => {
  assert.equal(stripShellPrompt('dreycore@archlinux:~/proj$ git status'), 'git status');
  assert.equal(stripShellPrompt('(venv) [root@prod /srv]# systemctl status nginx'), 'systemctl status nginx');
  assert.equal(stripShellPrompt('└─❯ docker ps -a'), 'docker ps -a');
  assert.equal(stripShellPrompt('└─) npm run dev'), 'npm run dev');
  assert.equal(stripShellPrompt('╰─$ cargo test'), 'cargo test');
  assert.equal(stripShellPrompt('PS C:\\Users\\dev> git pull'), 'git pull');
  assert.equal(stripShellPrompt('> echo continued'), 'echo continued');
  assert.equal(stripShellPrompt('plain output without prompt'), null);
});

test('extractNextSuggestionWord slices one word or path segment at a time for Ctrl+ArrowRight', () => {
  assert.equal(extractNextSuggestionWord(' compose up -d'), ' compose');
  assert.equal(extractNextSuggestionWord('cker compose up -d'), 'cker');
  assert.equal(extractNextSuggestionWord('/log/nginx/error.log'), '/log');
  assert.equal(extractNextSuggestionWord(' /var/log/syslog'), ' /var');
  assert.equal(extractNextSuggestionWord(' --tail=100'), ' --tail=100');
  assert.equal(extractNextSuggestionWord(''), '');
});

test('rankGhostSuggestion prioritizes host+CWD > host > starred > global > built-in with frecency', () => {
  const nowMs = 1_750_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  assert.equal(normalizeHistoryTimestampMs(nowSec), nowSec * 1000);
  assert.equal(normalizeHistoryTimestampMs(nowMs), nowMs);

  const entries = [
    // Other host, very recent
    {
      id: '1',
      hostId: 'prod-1',
      hostLabel: 'Prod 1',
      command: 'systemctl restart nginx',
      cwd: '/etc/nginx',
      executedAt: nowSec - 10,
      starred: false,
      runCount: 8,
    },
    // Other host, starred
    {
      id: '2',
      hostId: 'staging-1',
      hostLabel: 'Staging',
      command: 'systemctl status postgresql',
      cwd: '~',
      executedAt: nowSec - 86400,
      starred: true,
      runCount: 2,
    },
    // Local host, different CWD, recent
    {
      id: '3',
      hostId: null,
      hostLabel: 'Local Terminal',
      command: 'npm run deploy',
      cwd: '/home/dev/other',
      executedAt: nowSec - 60,
      starred: false,
      runCount: 1,
    },
    // Local host, same CWD, slightly older
    {
      id: '4',
      hostId: null,
      hostLabel: 'Local Terminal',
      command: 'npm run dev',
      cwd: '/home/dev/app/',
      executedAt: nowSec - 7200,
      starred: false,
      runCount: 5,
    },
    // Local host, systemctl command
    {
      id: '5',
      hostId: null,
      hostLabel: 'Local Terminal',
      command: 'systemctl --user status pipewire',
      cwd: '~',
      executedAt: nowSec - 3600,
      starred: false,
      runCount: 3,
    },
  ];

  // 1. Same host + same CWD (trailing slash normalized) beats same host different CWD
  const cwdMatch = rankGhostSuggestion('npm ', entries, { hostId: null, cwd: '/home/dev/app', nowMs });
  assert.deepEqual(cwdMatch, { full: 'npm run dev', suffix: 'run dev', source: 'history' });

  // 2. Same host beats newer command from another host
  const hostMatch = rankGhostSuggestion('sys', entries, { hostId: null, cwd: '~', nowMs });
  assert.deepEqual(hostMatch, {
    full: 'systemctl --user status pipewire',
    suffix: 'temctl --user status pipewire',
    source: 'history',
  });

  // 3. On a brand-new host with no own history, starred cross-host beats unstarred cross-host
  const starredMatch = rankGhostSuggestion('sys', entries, { hostId: 'new-server', cwd: '~', nowMs });
  assert.deepEqual(starredMatch, {
    full: 'systemctl status postgresql',
    suffix: 'temctl status postgresql',
    source: 'history',
  });

  // 4. Falls back to built-in catalog when history has no prefix match
  const builtinMatch = rankGhostSuggestion('cargo ', entries, { hostId: null, cwd: '~', nowMs });
  assert.deepEqual(builtinMatch, { full: 'cargo check', suffix: 'check', source: 'builtin' });

  // 5. Rejects < 2 chars and exact-length matches
  assert.equal(rankGhostSuggestion('n', entries, { hostId: null, cwd: '~', nowMs }), null);
  assert.equal(rankGhostSuggestion('npm run dev', entries, { hostId: null, cwd: '/home/dev/app', nowMs }), null);
});

test('CommandHistoryStore deduplicates, bumps runCount, filters secrets, and broadcasts live updates', async () => {
  const store = new CommandHistoryStore();
  let notifications = 0;
  const unsub = store.subscribe(() => {
    notifications++;
  });

  await store.hydrate(async () => [
    { id: 'a', hostId: null, hostLabel: 'Local', command: 'git status', cwd: '~/a', executedAt: 1000, starred: true, runCount: 2 },
    { id: 'b', hostId: null, hostLabel: 'Local', command: 'git status', cwd: '~/a', executedAt: 900, starred: false, runCount: 1 },
    { id: 's', hostId: null, hostLabel: 'Local', command: 'export API_KEY=nope', cwd: '~', executedAt: 1100, starred: false, runCount: 1 },
  ]);

  // Deduplicated and secret stripped
  assert.equal(store.getEntries().length, 1);
  assert.equal(store.getEntries()[0].id, 'a');
  assert.equal(store.getEntries()[0].starred, true);

  // Sensitive commands are ignored by record()
  assert.equal(store.record({ hostId: null, hostLabel: 'Local', command: 'curl -H "Bearer secret" x' }), null);
  assert.equal(store.getEntries().length, 1);

  // Recording existing command bumps runCount, updates cwd, and preserves starred
  const bumped = store.record({ hostId: null, hostLabel: 'Local', command: 'git status', cwd: '~/b', executedAt: 2000 });
  assert.equal(bumped?.runCount, 3);
  assert.equal(bumped?.starred, true);
  assert.equal(bumped?.cwd, '~/b');

  // Recording new command + reconciling backend id
  store.record({ hostId: null, hostLabel: 'Local', command: 'docker ps -a', cwd: '~/b', executedAt: 3000 });
  assert.equal(store.getEntries()[0].command, 'docker ps -a');
  store.reconcile({
    id: 'db-99',
    hostId: null,
    hostLabel: 'Local',
    command: 'docker ps -a',
    cwd: '~/b',
    executedAt: 3000,
    starred: false,
    runCount: 1,
  });
  assert.equal(store.getEntries()[0].id, 'db-99');

  // Clear unstarred removes docker ps -a but keeps starred git status
  store.clearUnstarred();
  assert.equal(store.getEntries().length, 1);
  assert.equal(store.getEntries()[0].command, 'git status');

  // Remove deletes remaining item
  store.remove('a');
  assert.equal(store.getEntries().length, 0);
  assert.ok(notifications >= 5);

  unsub();
});
