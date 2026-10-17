// Secret scan (STG-003): no credential and no well-known starting password in
// a tracked file.
//
//   node scripts/security/secret-scan.mjs            every file `git ls-files` lists
//   node scripts/security/secret-scan.mjs FILE...    only these (the tests' form)
//
// Exit 0 = clean, 1 = findings, 2 = the scan itself could not run.
//
// What it looks for, and why each rule is shaped the way it is:
//
//   known-initial-password   a password that has shipped as somebody's default
//                            (the old seed's, the old fixtures', the usual
//                            suspects). Compared as sha256 of the lower-cased
//                            token, so the list below names no password —
//                            this file would otherwise be the one place that
//                            keeps publishing them.
//   private-key              a PEM private key block.
//   provider-token           the fixed-prefix formats of the services a
//                            repository like this one talks to, or might:
//                            AWS, GitHub, Slack, Stripe live keys, Google API
//                            keys, SendGrid, Resend, Cloudflare Turnstile
//                            secrets, and signed JWTs (Lemon Squeezy's API key
//                            is one). Each pattern is the real format, so the
//                            repository's deliberate placeholders
//                            (`re_placeholderNotARealKey`, Cloudflare's
//                            published `1x000…AA` test secret, a JWT whose
//                            payload is not one) do not match.
//   credential-assignment    `…PASSWORD=`, `…SECRET:`, `…_API_KEY=`, `…_TOKEN=`
//                            with a long, high-entropy literal value. A value
//                            taken from the environment (`${X}`, `$X`), a
//                            `<described placeholder>`, or one that says it is
//                            a placeholder is not a credential.
//   database-url-password    a connection string carrying a long literal
//                            password. The local stack's `taktic_password` and
//                            CI's throwaway values are short and stay legal.
//
// A finding prints the file, the line, the rule and a redacted preview — the
// first four characters and the length. The matched value itself is never
// written anywhere: a scan that leaks what it found is a second leak.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * sha256(lower-case(password)) of the passwords that must never appear again.
 * Add to it with:
 *   node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1].toLowerCase()).digest("hex"))' 'value'
 */
export const KNOWN_INITIAL_PASSWORD_HASHES = new Set([
  'f61d2974715477dfe92bcb8ed5b767abdce80a0d2dae0ca07a99c5e4901a1d30',
  '494a715f7e9b4071aca61bac42ca858a309524e5864f0920030862a4ae7589be',
  '9ab3cd9d67bf49d01f6a2e33d0bd9bc804ddbe6ce1ff5d219c42624851db5dbc',
  'd16a108f42aa84bfe35d12183ce0b480dfbf21523055f29c3b7d9fe8e419b7a6',
  '5751a44782594819e4cb8aa27c2c9d87a420af82bc6a5a05bc7f19c3bb00452b',
  'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f',
  '65c21921ca10a8502757efc9aa552874d181c6206feb2845a921eb57f5e518d4',
  'b7aa19d33add937b884a01b4567a7e2038d46f179ec3d317a66c2c5f927cd06c',
  '3458cbe7a5d0c40cb559750478908406cf2a613af7e7c7465525ce8af8b45916',
  'd8dc1ecd5f68f8c56827ba6bcabddae98a17033ebaf37498e5a80c921799078a',
  '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',
  '5c06eb3d5a05a19f49476d694ca81a36344660e9d5b98e3d6a6630f31c2422e7',
  'ac9689e2272427085e35b9d3e3e8bed88cb3434828b43b86fc0596cad4c6e270',
  '7282ce7d1ef34a396f5ee8281a6bf9a28cfad67a687dc925823351fb7f0cb6b6',
  '87bc413ab73113f45f82e31c0b3881f2fcfab68fb693cd425fc023302bb4517f',
  'b793a7ce1c4ea8277f794f055b5020cc83f1dc1614992096c202845dd99abab4',
  '9c781a9a01bcad170381302ba11629a1af2ca0f8734b1acb43aa88888cf4356a',
  '8251f31b8dfaa422ff300192ec1b6a8fd4ecf5f01c0f12f6974eab2d19515090',
  '3bb2f3036b31ab21bca425f8a6dce6fbfb2bd5090e0bdd4bee46f9595f72f83a',
  'd354467919f108970aeada6436cfb81ae597f4a714e29eb49aad9d3148c1c5c3',
  '979280beeae65a3aaff20e78f94f69463530bfd23e3e62dc4be7dad4b8c5c83d',
  'ff76f204c1ae38467d2d63cc3a6042316b4e8034822c31e5956362482173c29f',
  'd27c5b2db7dc392a0cfeb18b9782f34709d1dea7bdb8dd7209f6d4c7387c7910',
  '389c0aff3d8ad1a0e958525895a8ac4b632ba08058efe05f67d039bcd8a79d0d',
]);

/** Files that are never source: lockfiles, binaries, generated output. */
const SKIPPED_PATHS = [/^pnpm-lock\.yaml$/, /(^|\/)node_modules\//, /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz)$/i];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const PROVIDER_TOKENS = [
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['stripe-live-key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g],
  ['resend-key', /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}\b/g],
  ['turnstile-secret', /\b0x4AAAAAAA[A-Za-z0-9_-]{20,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g],
];

const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g;

const CREDENTIAL_ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|SECRET_KEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH_TOKEN|_TOKEN))\b["']?\s*[:=]\s*(["'`]?)([^\s"'`#,;}]+)\2/g;

/**
 * Files whose values are written bare (`KEY=value`). In code a bare value is an
 * expression — `generateFixturePassword()`, `process.env.X`, another constant —
 * so there only a quoted literal is a candidate.
 */
const BARE_VALUE_FILES = /(^|\/)(\.env[^/]*|[^/]*\.ya?ml|[^/]*\.sh|Dockerfile[^/]*|[^/]*\.(?:conf|ini|toml|properties))$/;

const DATABASE_URL = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:([^@\s]+)@/g;

const PLACEHOLDER = /placeholder|example|not[-_]?(?:a[-_]?)?real|dummy|fake|redacted|changeme|your[-_]|xxx/i;

/** Shannon entropy in bits per character. */
export function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksLikeLiteralSecret(value, minLength) {
  if (value.length < minLength) return false;
  if (/[$<>{}]/.test(value)) return false;
  if (PLACEHOLDER.test(value)) return false;
  return entropy(value) >= 3.5;
}

export function redact(value) {
  return `${value.slice(0, 4)}… (${value.length} chars)`;
}

function hashToken(token) {
  return createHash('sha256').update(token.toLowerCase()).digest('hex');
}

/** Every candidate password-shaped token on a line, stripped of quoting. */
function tokens(line) {
  return line.split(/[\s'"`()[\]{},;=<>|]+/).filter((token) => token.length >= 6 && token.length <= 64);
}

/** Findings in one file's text. Pure, so the tests can feed it strings. */
export function scanText(path, text) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const at = { path, line: index + 1 };
    for (const token of tokens(line)) {
      // A token often carries trailing punctuation from prose: `x!`, `x.`, `x:`.
      for (const candidate of new Set([token, token.replace(/[.:]+$/, '')])) {
        if (KNOWN_INITIAL_PASSWORD_HASHES.has(hashToken(candidate))) {
          findings.push({ ...at, rule: 'known-initial-password', preview: redact(candidate) });
        }
      }
    }
    for (const match of line.matchAll(PRIVATE_KEY)) {
      findings.push({ ...at, rule: 'private-key', preview: redact(match[0]) });
    }
    for (const [rule, pattern] of PROVIDER_TOKENS) {
      for (const match of line.matchAll(pattern)) {
        if (PLACEHOLDER.test(match[0])) continue;
        findings.push({ ...at, rule, preview: redact(match[0]) });
      }
    }
    for (const match of line.matchAll(CREDENTIAL_ASSIGNMENT)) {
      const [, name, quote, value] = match;
      if (!quote && !BARE_VALUE_FILES.test(path)) continue;
      // `${X:-default}` / `${X:?message}`: the shell's default and its error text.
      if (/^[-?]/.test(value)) continue;
      if (looksLikeLiteralSecret(value, 16)) {
        findings.push({ ...at, rule: 'credential-assignment', preview: `${name}=${redact(value)}` });
      }
    }
    for (const match of line.matchAll(DATABASE_URL)) {
      if (looksLikeLiteralSecret(match[1], 16)) {
        findings.push({ ...at, rule: 'database-url-password', preview: redact(match[1]) });
      }
    }
  });
  return findings;
}

export function trackedFiles(cwd = process.cwd()) {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return output.split('\0').filter(Boolean);
}

export function scanFiles(paths) {
  const findings = [];
  let scanned = 0;
  for (const path of paths) {
    if (SKIPPED_PATHS.some((pattern) => pattern.test(path))) continue;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue; // listed but deleted in the working tree
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const buffer = readFileSync(path);
    if (buffer.includes(0)) continue; // binary
    scanned += 1;
    findings.push(...scanText(path, buffer.toString('utf8')));
  }
  return { scanned, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const explicit = process.argv.slice(2);
    const { scanned, findings } = scanFiles(explicit.length > 0 ? explicit : trackedFiles());
    for (const finding of findings) {
      console.log(`::error file=${finding.path},line=${finding.line}::${finding.rule}: ${finding.preview}`);
    }
    console.log(`secret-scan: ${scanned} file(s) scanned, ${findings.length} finding(s)`);
    process.exitCode = findings.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`secret-scan: could not run — ${error.message}`);
    process.exitCode = 2;
  }
}
