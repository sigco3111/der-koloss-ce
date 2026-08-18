// Every HTML page in the repo root must be either a real page or excluded
// from the deploy.
//
// This game ships as a static site: whatever sits in the repo root is served.
// While building a feature it is genuinely useful to drop a scratch page there
// — a face lab, a hound preview, a stair probe — because a lab page needs the
// real import map and the real asset paths, and those only resolve from the
// root. The problem is purely that nothing stopped one from being deployed.
//
// We have had seven of them in the root at once (__chalk-lab.html,
// __fists-lab.html, __hound.html, __stairprobe.html, __title-lab.html,
// _boxcheck.html, soldiers.html), all live, all reachable by URL on the
// deployed site. None of them are the player experience, several expose
// internal tooling, and one of them was deleted mid-session by mistake because
// nobody could tell a live lab from dead residue.
//
// So the rule is not "no scratch pages" — they are legitimately useful. The
// rule is that a scratch page must be DECLARED: it either appears in the
// allowlist below because it is a real page, or it is matched by a pattern in
// .vercelignore so it cannot ship. Anything else is a page nobody decided on,
// and that is what this fails.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Real pages, deliberately served. Adding to this list is a decision to ship
// a page to players — do not add a lab page here to silence the validator.
const REAL_PAGES = new Set(['index.html', '404.html']);

/** Translate the small glob subset used in ignore files into a RegExp. */
function toRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function ignorePatterns(file) {
  const path = join(root, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(toRegExp);
}

const deployIgnored = ignorePatterns('.vercelignore');
const gitIgnored = ignorePatterns('.gitignore');

// Root-level HTML that git already tracks. Runs with cwd at the repo root and
// tolerates the whole thing failing: this validator must still work in a
// tarball or a checkout without git, where "is it tracked" is simply unknown.
let tracked = new Set();
try {
  tracked = new Set(
    execFileSync('git', ['ls-files', '--', '*.html'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((p) => p && !p.includes('/')),
  );
} catch {
  tracked = new Set();
}

const rootHtml = readdirSync(root).filter((n) => n.endsWith('.html'));
const failures = [];

for (const name of rootHtml) {
  if (REAL_PAGES.has(name)) continue;
  const deployed = !deployIgnored.some((re) => re.test(name));
  if (deployed) {
    failures.push(
      `${name} would be DEPLOYED. It is not a real page (see REAL_PAGES) and no ` +
      `.vercelignore pattern matches it. Either add it to REAL_PAGES if players ` +
      `should see it, or add a pattern to .vercelignore so it stays local.`,
    );
    continue;
  }
  // Deploy-excluded but still committable is a weaker failure, and worth
  // catching: a committed lab page is one bad .vercelignore edit from shipping.
  //
  // Files already TRACKED by git are exempt. Committing one was a deliberate
  // decision that someone made and can be seen in history — cinematic.html is
  // the standing example, internal trailer-capture tooling that is versioned on
  // purpose and excluded from the deploy. The risk this catches is the other
  // shape: an UNTRACKED lab page sitting in the root that a stray `git add -A`
  // would sweep in.
  if (tracked.has(name)) continue;
  if (!gitIgnored.some((re) => re.test(name))) {
    failures.push(
      `${name} is excluded from the deploy but NOT from git. Add a matching ` +
      `pattern to .gitignore so it cannot be committed by an "add -A".`,
    );
  }
}

if (failures.length) {
  console.error('Undeclared HTML pages in the repo root:\n');
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(`validate-no-scratch-pages: ${rootHtml.length} root HTML file(s) checked, all declared.`);
