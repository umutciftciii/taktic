import { closeSync, openSync, writeSync } from 'node:fs';
import { isatty, ReadStream } from 'node:tty';
import { bootstrapPasswordProblem } from '../common/bootstrap-password';

/**
 * Reads a password an operator types into their own terminal (STG-003), so it
 * never travels through an argument, an environment variable or a log.
 *
 * The prompt and the keystrokes go through `/dev/tty`, not stdin/stdout: a
 * redirected or `tee`d output never carries the prompt, and a value piped
 * into stdin is never read. Echo is off (raw mode) and nothing is drawn per
 * key — no asterisks, so not even the length shows on screen.
 *
 * With no controlling terminal — `docker compose run -T`, a pipe, cron, CI —
 * the read is refused before anything else happens.
 */

/** Shows `prompt` and returns what the person typed, without echoing it. */
export type SecretReader = (prompt: string) => Promise<string>;

export class NoTerminal extends Error {}

/** The entry was refused: cancelled, mismatched or too weak. Never carries the value. */
export class SecretEntryRefused extends Error {}

/** `/dev/tty` opened read-write; the controlling terminal, or a throw. */
function openControllingTerminal(): number {
  return openSync('/dev/tty', 'r+');
}

export type KeyState = { chars: string[] };

/**
 * Applies one chunk of raw-mode input. Returns 'done' at Enter, 'cancelled' at
 * Ctrl-C / Ctrl-D, and 'more' otherwise. Backspace removes the last
 * character; any other control key (arrows, Escape, Tab) is refused rather
 * than silently becoming part of a password nobody can retype.
 */
export function applyKeys(state: KeyState, chunk: string): 'more' | 'done' | 'cancelled' | 'control' {
  for (const char of Array.from(chunk)) {
    if (char === '\r' || char === '\n') return 'done';
    if (char === '\u0003' || char === '\u0004') return 'cancelled';
    if (char === '\u007f' || char === '\b') {
      state.chars.pop();
      continue;
    }
    const code = char.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 'control';
    state.chars.push(char);
  }
  return 'more';
}

/** A reader that holds the terminal open in raw mode until `close`. */
export type TerminalSecretReader = SecretReader & { close(): void };

/**
 * A reader on the controlling terminal. The terminal is opened at the first
 * prompt and kept in raw mode across every prompt until `close()`: switching
 * back to cooked mode between two entries — or closing one handle while the
 * next is open, which makes libuv restore the saved mode under it — would
 * echo whatever is typed in that gap. `openTerminal` is injectable so the
 * refusal paths can be exercised without one.
 */
export function terminalSecretReader(openTerminal: () => number = openControllingTerminal): TerminalSecretReader {
  let session: { fd: number; input: ReadStream } | null = null;

  const open = () => {
    if (session) return session;
    let fd: number;
    try {
      fd = openTerminal();
    } catch {
      throw new NoTerminal(noTerminalMessage());
    }
    if (!isatty(fd)) {
      closeSync(fd);
      throw new NoTerminal(noTerminalMessage());
    }
    const input = new ReadStream(fd);
    // Raw before the first prompt is drawn, so nothing typed ahead is echoed.
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.pause();
    session = { fd, input };
    return session;
  };

  const read = async (prompt: string): Promise<string> => {
    const { fd, input } = open();
    writeSync(fd, prompt);
    const state: KeyState = { chars: [] };
    const outcome = await new Promise<'done' | 'cancelled' | 'control'>((resolve, reject) => {
      const stop = () => {
        input.off('data', onData);
        input.off('error', onError);
        input.off('end', onEnd);
        input.pause();
      };
      const onData = (chunk: string) => {
        const result = applyKeys(state, chunk);
        if (result === 'more') return;
        stop();
        resolve(result);
      };
      const onError = (error: Error) => {
        stop();
        reject(error);
      };
      // The terminal closed mid-entry: the same as giving up.
      const onEnd = () => {
        stop();
        resolve('cancelled');
      };
      input.on('data', onData);
      input.on('error', onError);
      input.on('end', onEnd);
      input.resume();
    });
    writeSync(fd, '\n');
    if (outcome === 'cancelled') throw new SecretEntryRefused('password entry cancelled; nothing changed');
    if (outcome === 'control') {
      throw new SecretEntryRefused('password entry refused: a control key (arrow, Escape, Tab…) was pressed; nothing changed');
    }
    return state.chars.join('');
  };

  const close = () => {
    if (!session) return;
    const { input } = session;
    session = null;
    try {
      input.setRawMode(false);
    } catch {
      // The terminal went away; there is nothing left to restore.
    }
    input.destroy();
  };

  return Object.assign(read, { close });
}

function noTerminalMessage(): string {
  return (
    'no terminal to read the password from (stdin is not a TTY: `docker compose run -T`, a pipe, cron or CI). ' +
    'Run it yourself in a terminal, without -T; the password is typed at a hidden prompt. Nothing changed.'
  );
}

/**
 * Asks for a new password twice on `read`, judging it by the bootstrap rule
 * after the first entry. Every refusal names the reason and never the value.
 */
export async function promptNewPassword(read: SecretReader, what: string): Promise<string> {
  const first = await read(`${what} (hidden, nothing is shown while you type): `);
  const problem = bootstrapPasswordProblem(first);
  if (problem) {
    throw new SecretEntryRefused(
      `the ${what} ${problem}. Generate one with: openssl rand -base64 24 — keep it in a password manager. Nothing changed.`,
    );
  }
  const second = await read(`${what} again: `);
  if (second !== first) throw new SecretEntryRefused(`the two ${what} entries do not match. Nothing changed.`);
  return first;
}

/**
 * The variables earlier versions read the password from. Set at all — even
 * empty — is refused: the value would already be sitting in a shell, a
 * process table or a compose file, which is what this tool exists to avoid.
 */
export const RETIRED_PASSWORD_VARS = ['SUPER_ADMIN_NEW_PASSWORD', 'SUPER_ADMIN_RECOVERY_PASSWORD'] as const;

export function refusePasswordEnvironment(env: NodeJS.ProcessEnv): void {
  const present = RETIRED_PASSWORD_VARS.filter((name) => env[name] !== undefined);
  if (present.length > 0) {
    throw new SecretEntryRefused(
      `${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set in the environment; passwords are no longer read from it. ` +
        `Unset ${present.length === 1 ? 'it' : 'them'} (and drop any -e for ${present.length === 1 ? 'it' : 'them'}), ` +
        'then type the password at the hidden prompt. Nothing changed.',
    );
  }
}
