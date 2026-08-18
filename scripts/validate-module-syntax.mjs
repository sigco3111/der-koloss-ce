// Parse every shipped ES module and fail on any syntax error.
//
// This exists because a single bad character in one module takes the ENTIRE
// game down, silently: index.html loads js/main.js as a module, so if any file
// in its import graph fails to parse, no module in the graph ever evaluates.
// Nothing is bound. The menu still renders — it is plain HTML and CSS — but
// every button is inert and the console error is easy to miss. It looks like a
// UI bug, not a parse error.
//
// The specific trap this was written for: all of the GLSL lives inside JS
// template literals, so ONE backtick typed inside a shader comment closes the
// string early and the shader source starts being parsed as JavaScript.
//
// `node --check` only applies module grammar when it believes the file is a
// module. These are .js files in a package with no "type": "module", so Node
// checks them as CommonJS and waves the error through — hence the copy to a
// .mjs temp file below. Do not "simplify" that away.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['js', 'scripts'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const files = roots.flatMap((r) => walk(join(root, r)));
const tmp = mkdtempSync(join(tmpdir(), 'derkoloss-syntax-'));
const failures = [];

for (const file of files) {
  const shim = join(tmp, 'check.mjs');
  writeFileSync(shim, readFileSync(file));
  try {
    execFileSync(process.execPath, ['--check', shim], { stdio: 'pipe' });
  } catch (err) {
    const detail = String(err.stderr || err.message)
      .split('\n')
      .filter((l) => l.trim() && !l.includes('check_syntax') && !l.startsWith('    at ') && !l.startsWith('Node.js v'))
      .slice(0, 6)
      .join('\n    ');
    failures.push(`${relative(root, file)}\n    ${detail}`);
  }
}
rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\nSyntax errors in ${failures.length} module(s):\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

// Guard the exact trap directly, so the intent survives even if someone
// reorganises the shader files: no backticks are allowed inside the GLSL
// files, because every one of them is a template literal from top to bottom.
const shaderFiles = walk(join(root, 'js', 'render')).filter((f) => /shaders\.js$/.test(f));
for (const f of shaderFiles) {
  const src = readFileSync(f, 'utf8');
  // Count backticks per line; a shader file should only ever have them as the
  // delimiters of an exported template literal, never inside a comment.
  src.split('\n').forEach((line, i) => {
    const ticks = (line.match(/`/g) || []).length;
    if (ticks && /^\s*(\/\/|\*|\/\*)/.test(line)) {
      console.error(`${relative(root, f)}:${i + 1} backtick inside a comment inside GLSL — this ends the template literal`);
      process.exit(1);
    }
  });
}

console.log(`module syntax OK (${files.length} files)`);
