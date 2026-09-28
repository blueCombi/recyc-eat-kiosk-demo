/**
 * serial-lines.js
 * Splits a serial stream into trimmed lines on CR, LF or CRLF.
 *
 * ReadlineParser cannot do this: it takes a single string or Buffer delimiter
 * and calls Buffer.from() on it, so handing it a regular expression throws.
 * Barcode scanners and Arduino sketches disagree about line endings, so the
 * kiosk accepts any of them.
 */
const MAX_BUFFER = 4096;

function attachLineReader(port, handler) {
  let buffer = "";
  let onLine = handler;

  port.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);

    const parts = buffer.split(/[\r\n]+/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.trim();
      if (line && typeof onLine === "function") onLine(line);
    }
  });

  return {
    // The hardware bridge listens anonymously while a board identifies itself,
    // then routes the same stream by role once it knows which board this is.
    setHandler(next) {
      onLine = next;
    },
  };
}

module.exports = { attachLineReader };
