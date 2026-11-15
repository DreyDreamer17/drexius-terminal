import type { DeployPresetKind, DeployProfile, Snippet } from './types';

export interface DeployPresetDefinition {
  id: DeployPresetKind;
  label: string;
  badge: string;
  description: string;
  sharedFiles: string[];
  sharedDirs: string[];
  buildScript: string;
  postSwapScript: string;
  defaultVars: Record<string, string>;
}

export const BUILTIN_RUNTIME_VARS = new Set([
  'app_dir',
  'release_dir',
  'shared_dir',
  'current_dir',
  'release_id',
  'repo_url',
  'branch',
  'keep_releases',
]);

export const DEPLOY_PRESETS: Record<DeployPresetKind, DeployPresetDefinition> = {
  laravel: {
    id: 'laravel',
    label: 'Laravel (Atomic Release)',
    badge: 'PHP / Laravel',
    description:
      'Clones into releases/<id>, symlinks shared .env & storage/, runs Composer + Artisan cache/migrate, atomically swaps current, and restarts queue workers.',
    sharedFiles: ['.env'],
    sharedDirs: ['storage'],
    buildScript: [
      '{{composer_bin}} install --no-dev --prefer-dist --no-interaction --optimize-autoloader',
      '{{php_bin}} artisan storage:link || true',
      '{{php_bin}} artisan config:cache',
      '{{php_bin}} artisan route:cache',
      '{{php_bin}} artisan view:cache',
      '{{php_bin}} artisan migrate --force',
    ].join('\n'),
    postSwapScript: [
      '{{php_bin}} artisan queue:restart || true',
      'sudo -n systemctl reload {{php_fpm_service}} 2>/dev/null || true',
    ].join('\n'),
    defaultVars: {
      php_bin: 'php',
      composer_bin: 'composer',
      php_fpm_service: 'php8.3-fpm',
    },
  },
  nodejs: {
    id: 'nodejs',
    label: 'Node.js / Next.js (PM2)',
    badge: 'Node / PM2',
    description:
      'Clones into releases/<id>, symlinks shared .env, installs dependencies & builds production bundle, swaps current symlink, and reloads PM2.',
    sharedFiles: ['.env'],
    sharedDirs: [],
    buildScript: [
      'npm ci',
      'npm run build',
    ].join('\n'),
    postSwapScript: 'pm2 reload {{pm2_app_name}} --update-env || pm2 restart {{pm2_app_name}}',
    defaultVars: {
      pm2_app_name: 'web-app',
    },
  },
  static: {
    id: 'static',
    label: 'Static / Vite / SPA',
    badge: 'Static / Nginx',
    description:
      'Clones into releases/<id>, runs frontend build in isolation, and atomically swaps current docroot symlink with zero downtime.',
    sharedFiles: ['.env'],
    sharedDirs: [],
    buildScript: [
      'npm ci',
      'npm run build',
    ].join('\n'),
    postSwapScript: '',
    defaultVars: {},
  },
  docker: {
    id: 'docker',
    label: 'Docker Compose Release',
    badge: 'Containers',
    description:
      'Clones release, links shared .env & data volumes, swaps current symlink, and runs docker compose up -d --build.',
    sharedFiles: ['.env'],
    sharedDirs: ['data'],
    buildScript: 'docker compose -f {{compose_file}} pull || true',
    postSwapScript: 'docker compose -f {{compose_file}} up -d --build --remove-orphans',
    defaultVars: {
      compose_file: 'docker-compose.yml',
    },
  },
  custom: {
    id: 'custom',
    label: 'Custom Script / Snippet Pipeline',
    badge: 'Custom Shell',
    description:
      'Clone into releases/<id>, run your own custom commands and attached Vault Snippets with {{variable}} templates, then swap current.',
    sharedFiles: ['.env'],
    sharedDirs: [],
    buildScript: '# Runs inside {{release_dir}} before symlink swap\necho "Building release {{release_id}} from {{branch}}..."',
    postSwapScript: '# Runs inside {{current_dir}} after symlink swap',
    defaultVars: {},
  },
};

/** Extracts all `{{variable}}` names from one or more script strings. */
export function extractAllPlaceholders(...scripts: string[]): string[] {
  const found = new Set<string>();
  for (const s of scripts) {
    if (!s) continue;
    for (const m of s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found];
}

/** Extracts custom user-defined `{{variable}}` names (excluding automatic runtime vars like `{{release_dir}}`). */
export function extractCustomPlaceholders(...scripts: string[]): string[] {
  return extractAllPlaceholders(...scripts).filter((k) => !BUILTIN_RUNTIME_VARS.has(k));
}

/** Interpolates `{{var}}` tokens using the provided variable map. */
export function interpolateVariables(script: string, vars: Record<string, string>): string {
  return script.replace(/\{\{\s*(\w+)\s*\}\}/g, (full, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : full
  );
}

/** Combines a profile's inline buildScript with any attached Vault Snippets in order. */
export function composeDeployBuildScript(profile: DeployProfile, snippets: Snippet[]): string {
  const parts: string[] = [];
  if (profile.buildScript.trim()) {
    parts.push(profile.buildScript.trim());
  }
  for (const sid of profile.snippetIds || []) {
    const found = snippets.find((s) => s.id === sid);
    if (found && found.command.trim()) {
      parts.push(`# ── Snippet: ${found.name} ──\n${found.command.trim()}`);
    }
  }
  return parts.join('\n\n');
}

/** Generates a complete, self-contained POSIX shell deployment script for running in an interactive terminal or copying. */
export function buildStandaloneDeployShellScript(
  profile: DeployProfile,
  snippets: Snippet[]
): string {
  const appDir = profile.appDir.trim().replace(/\/+$/, '') || '/var/www/app';
  const branch = profile.branch.trim() || 'main';
  const keep = Math.max(2, profile.keepReleases || 2);
  const combinedBuild = composeDeployBuildScript(profile, snippets);

  const vars: Record<string, string> = {
    ...profile.variables,
    app_dir: appDir,
    release_dir: '$RELEASE_DIR',
    shared_dir: '$APP_DIR/shared',
    current_dir: '$APP_DIR/current',
    release_id: '$RELEASE_ID',
    repo_url: profile.repoUrl.trim(),
    branch,
    keep_releases: String(keep),
  };

  const resolvedBuild = interpolateVariables(combinedBuild, vars);
  const resolvedPostSwap = interpolateVariables(profile.postSwapScript.trim(), vars);

  const sharedDirLines = (profile.sharedDirs || [])
    .map((d) => d.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .map(
      (d) =>
        `mkdir -p "$APP_DIR/shared/${d}" && rm -rf "$RELEASE_DIR/${d}" && ln -sfn "$APP_DIR/shared/${d}" "$RELEASE_DIR/${d}"`
    );

  const sharedFileLines = (profile.sharedFiles || [])
    .map((f) => f.trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .map(
      (f) =>
        `if [ ! -f "$APP_DIR/shared/${f}" ]; then [ -f "$RELEASE_DIR/${f}.example" ] && cp "$RELEASE_DIR/${f}.example" "$APP_DIR/shared/${f}" || touch "$APP_DIR/shared/${f}"; fi && rm -f "$RELEASE_DIR/${f}" && ln -sfn "$APP_DIR/shared/${f}" "$RELEASE_DIR/${f}"`
    );

  return [
    'set -euo pipefail',
    `APP_DIR='${appDir.replace(/'/g, "'\\''")}'`,
    `REPO_URL='${profile.repoUrl.trim().replace(/'/g, "'\\''")}'`,
    `BRANCH='${branch.replace(/'/g, "'\\''")}'`,
    `KEEP_RELEASES=${keep}`,
    'RELEASE_ID=$(date -u +%Y%m%d_%H%M%S)',
    'RELEASE_DIR="$APP_DIR/releases/$RELEASE_ID"',
    '',
    'echo "==> [1/5] Cloning $BRANCH into $RELEASE_DIR..."',
    'mkdir -p "$APP_DIR/releases" "$APP_DIR/shared"',
    'git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$RELEASE_DIR"',
    '',
    ...(sharedDirLines.length || sharedFileLines.length
      ? [
          'echo "==> [2/5] Linking shared files & directories..."',
          ...sharedDirLines,
          ...sharedFileLines,
          '',
        ]
      : []),
    ...(resolvedBuild
      ? [
          'echo "==> [3/5] Running build scripts & snippets..."',
          'cd "$RELEASE_DIR"',
          resolvedBuild,
          '',
        ]
      : []),
    'echo "==> [4/5] Atomically swapping current symlink..."',
    'ln -sfn "$RELEASE_DIR" "$APP_DIR/.current_tmp" && (mv -Tf "$APP_DIR/.current_tmp" "$APP_DIR/current" 2>/dev/null || ln -sfn "$RELEASE_DIR" "$APP_DIR/current")',
    ...(resolvedPostSwap ? ['cd "$APP_DIR/current"', resolvedPostSwap] : []),
    '',
    'echo "==> [5/5] Keeping previous release & pruning older releases..."',
    'cd "$APP_DIR/releases" && ls -1dt */ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | tr -d "/" | xargs -r rm -rf --',
    'echo "✅ Deployed release $RELEASE_ID ($BRANCH) -> $APP_DIR/current"',
  ].join('\n');
}

export const SNIPPET_STARTER_TEMPLATES: Array<{
  name: string;
  folder: string;
  tags: string[];
  command: string;
}> = [
  {
    name: 'Laravel Atomic Git Deploy',
    folder: 'Deploy',
    tags: ['laravel', 'php', 'deploy', 'git'],
    command: [
      'set -euo pipefail',
      'APP_DIR="{{app_dir}}"',
      'RELEASE_ID=$(date -u +%Y%m%d_%H%M%S)',
      'RELEASE_DIR="$APP_DIR/releases/$RELEASE_ID"',
      'mkdir -p "$APP_DIR/releases" "$APP_DIR/shared/storage"',
      'git clone --depth 1 --branch "{{branch}}" "{{repo_url}}" "$RELEASE_DIR"',
      'ln -sfn "$APP_DIR/shared/.env" "$RELEASE_DIR/.env"',
      'rm -rf "$RELEASE_DIR/storage" && ln -sfn "$APP_DIR/shared/storage" "$RELEASE_DIR/storage"',
      'cd "$RELEASE_DIR" && composer install --no-dev --prefer-dist --no-interaction --optimize-autoloader',
      'php artisan config:cache && php artisan route:cache && php artisan view:cache && php artisan migrate --force',
      'ln -sfn "$RELEASE_DIR" "$APP_DIR/.current_tmp" && mv -Tf "$APP_DIR/.current_tmp" "$APP_DIR/current"',
      'php artisan queue:restart || true',
      'cd "$APP_DIR/releases" && ls -1dt */ | tail -n +3 | xargs -r rm -rf --',
    ].join('\n'),
  },
  {
    name: 'Rollback to Previous Release',
    folder: 'Deploy',
    tags: ['rollback', 'deploy', 'laravel'],
    command: [
      'APP_DIR="{{app_dir}}"',
      'PREV=$(ls -1dt "$APP_DIR/releases"/* | sed -n "2p")',
      'if [ -n "$PREV" ]; then ln -sfn "$PREV" "$APP_DIR/.current_tmp" && mv -Tf "$APP_DIR/.current_tmp" "$APP_DIR/current" && echo "Rolled back to $PREV"; else echo "No previous release found"; exit 1; fi',
    ].join('\n'),
  },
  {
    name: 'Laravel Cache & Migrate Hook',
    folder: 'Deploy',
    tags: ['laravel', 'artisan'],
    command:
      '{{php_bin}} artisan config:cache && {{php_bin}} artisan route:cache && {{php_bin}} artisan view:cache && {{php_bin}} artisan migrate --force',
  },
];
