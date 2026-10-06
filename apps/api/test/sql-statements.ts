/**
 * PostgreSQL statements, split out of a file.
 *
 * Prisma refuses a raw call carrying more than one command, so the file has to
 * be handed over a statement at a time. Splitting on ";" alone would cut the
 * guard blocks in half — their bodies are full of semicolons — so this walks
 * the text and skips over what a semicolon does not end: line comments, quoted
 * literals, and dollar-quoted bodies.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;

  while (index < sql.length) {
    const rest = sql.slice(index);

    if (rest.startsWith('--')) {
      const newline = sql.indexOf('\n', index);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }

    if (sql[index] === "'") {
      index = endOfQuoted(sql, index);
      continue;
    }

    const dollarTag = /^\$[A-Za-z_0-9]*\$/.exec(rest)?.[0];
    if (dollarTag) {
      const close = sql.indexOf(dollarTag, index + dollarTag.length);
      index = close === -1 ? sql.length : close + dollarTag.length;
      continue;
    }

    if (sql[index] === ';') {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      index += 1;
      start = index;
      continue;
    }

    index += 1;
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);

  return statements;
}

/** The index just past a single-quoted literal, '' escapes included. */
function endOfQuoted(sql: string, openQuote: number): number {
  let index = openQuote + 1;
  while (index < sql.length) {
    if (sql[index] !== "'") {
      index += 1;
      continue;
    }
    if (sql[index + 1] === "'") {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return sql.length;
}
