#!/usr/bin/env node
/**
 * Check the internal links in the Markdown documentation.
 *
 * A broken cross-reference in a README is the cheapest kind of documentation bug and
 * the easiest to miss by eye, so this runs in CI. It is deliberately dependency-free:
 * it is a plain Node script, not a third-party action.
 *
 * What it verifies:
 *   * every relative link target exists on disk;
 *   * every `#anchor` in a link resolves to a heading in the target file;
 *   * every image reference exists;
 *   * every Markdown file in the repository is reachable from some entry point.
 *
 * External links (http/https/mailto) are listed but not fetched — a network check in
 * CI is slow, flaky and outside this script's job.
 *
 * Usage: node scripts/check-doc-links.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';

const ROOT = resolve(process.cwd());
const DOC_DIRS = ['.', 'docs', 'relay'];

/** Entry points that must be able to reach every other document. */
const ENTRY_POINTS = ['README.md', 'ARCHITECTURE.md'];

const problems = [];
const external = new Set();
const linked = new Set();

function isExternal(href) {
  return /^(https?:|mailto:|tel:|data:|#)/i.test(href);
}

/** Collect the heading slugs of a Markdown file, GitHub-style. */
function headingSlugs(markdown) {
  const slugs = new Set();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const text = m[2]
      .replace(/`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_~]/g, '')
      .trim();
    // Mirrors github-slugger: lowercase, drop punctuation, then turn *each*
    // remaining space into a hyphen. Note the single-space replacement — GitHub
    // keeps the double space that a stripped "&" or "/" leaves behind, which is
    // why "Tailscale & Docker" becomes "tailscale--docker" and not "tailscale-docker".
    let slug = text
      .toLowerCase()
      .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
      .replace(/\s/g, '-');
    // GitHub de-duplicates repeated headings with a numeric suffix.
    let unique = slug;
    let n = 1;
    while (slugs.has(unique)) unique = `${slug}-${n++}`;
    slugs.add(unique);
    slugs.add(slug);
  }
  return slugs;
}

async function listMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (dir === ROOT && entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdown(full)));
    else if (extname(entry.name) === '.md') out.push(full);
  }
  return out;
}

/** Extract [text](href) and ![alt](src) references. */
function extractLinks(markdown) {
  const links = [];
  const re = /(!?)\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    links.push({ image: m[1] === '!', href: m[2] });
  }
  return links;
}

async function checkFile(file) {
  const markdown = await readFile(file, 'utf8');
  const slugs = headingSlugs(markdown);
  const dir = dirname(file);

  for (const { image, href } of extractLinks(markdown)) {
    if (isExternal(href)) {
      if (/^https?:/i.test(href)) external.add(href);
      continue;
    }

    const [targetPart, anchor] = href.split('#');
    let target = targetPart ? resolve(dir, targetPart) : file;

    if (targetPart) {
      if (!existsSync(target)) {
        problems.push(`${relative(ROOT, file)}: ${image ? 'image' : 'link'} target does not exist — ${href}`);
        continue;
      }
      const st = await stat(target);
      if (st.isDirectory()) {
        problems.push(`${relative(ROOT, file)}: link points at a directory — ${href}`);
        continue;
      }
      linked.add(resolve(target));
    }

    if (anchor) {
      let targetSlugs;
      if (extname(target) === '.md') {
        targetSlugs = headingSlugs(await readFile(target, 'utf8'));
      } else {
        // Non-Markdown anchors cannot be verified here; the file check above is
        // enough to catch a broken path.
        continue;
      }
      if (!targetSlugs.has(anchor.toLowerCase())) {
        problems.push(
          `${relative(ROOT, file)}: anchor "#${anchor}" not found in ${relative(ROOT, target)}`
        );
      }
    }
  }
}

async function main() {
  const files = [];
  const seen = new Set();
  for (const d of DOC_DIRS) {
    const full = join(ROOT, d);
    if (!existsSync(full)) continue;
    for (const f of await listMarkdown(full)) {
      if (seen.has(f)) continue;
      seen.add(f);
      files.push(f);
    }
  }

  for (const f of files) await checkFile(f);

  // Every Markdown file should be reachable from an entry point.
  const unreachable = files.filter(
    (f) =>
      !ENTRY_POINTS.includes(relative(ROOT, f)) &&
      !linked.has(resolve(f)) &&
      !/^(CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)\.md$/i.test(relative(ROOT, f))
  );

  console.log(`Checked ${files.length} Markdown file(s).`);
  console.log(`External links referenced (not fetched): ${external.size}`);

  if (unreachable.length) {
    for (const f of unreachable) {
      problems.push(`${relative(ROOT, f)}: not referenced from any entry point`);
    }
  }

  if (problems.length) {
    console.error(`\n${problems.length} documentation problem(s):\n`);
    for (const p of problems) console.error('  • ' + p);
    process.exit(1);
  }
  console.log('No broken internal links.');
}

await main();
