// Bulk fast-path csv-reader-exact scanner.
//
// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly what
// csv-reader 1.0.0 returns for {text, header} -> {columns, rows, errors},
// but parsed with bulk String.indexOf scans instead of one character at a
// time.
//
// Three tiers:
//  * Bulk record path: a record whose line holds no quote and no stray CR
//    is sliced whole and split(',') in one go.
//  * Bulk run path: inside a record, a run of unquoted fields up to the
//    next field-starting quote (or the end of the line) is split(',') in
//    one go; a quote only counts as field-starting when it opens the
//    field, so a quote inside an unquoted field stays a literal.
//  * Field path: unquoted fields are found with indexOf for the next
//    comma / LF / CR; quoted fields are found with indexOf for the
//    closing quote, with doubled quotes collapsed and CR/CRLF inside
//    quotes read as LF. Only fields that actually need it pay for the
//    careful segment-by-segment work.
//
// Written from the csv-reader 1.0.0 specification (RULES.txt): a U+FEFF at
// the very start is dropped, empty lines are no record, a stray CR outside
// quotes is dropped with a stray_cr error, what follows a closing quote up
// to the next comma or line break is appended as it stands (quote_junk),
// a quote that never closes is a literal character and the text after it
// is read again as unquoted (unterminated_quote), fields stay strings,
// short_row pads and long_row cuts to the first record's width, and every
// error carries the 1-based line its record starts on and its index in
// rows (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // The field just read.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Applies the first-record width and the short_row / long_row policy to
  // a finished record; returns true when it was the header.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return true;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
    return false;
  }

  // Reads an unquoted field from pos, starting from `value` ('' normally,
  // the quoted content when reading junk after a closing quote, '"' when
  // re-reading an unterminated quote). Sets fValue/fEnded/fAdded; fAdded
  // counts only the characters appended here.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      const c = text.indexOf(',', pos);
      const l = text.indexOf('\n', pos);
      const r = text.indexOf('\r', pos);
      let end = -1;
      let kind = END;
      if (c !== -1) { end = c; kind = COMMA; }
      if (l !== -1 && (end === -1 || l < end)) { end = l; kind = LINE_BREAK; }
      if (r !== -1 && (end === -1 || r < end)) { end = r; kind = 3; }
      if (kind === 3 && text.charCodeAt(end + 1) !== 10) {
        // A CR not followed by LF: dropped, with a stray_cr error, and
        // the field goes on.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += text.slice(pos, end);
        added += end - pos;
        pos = end + 1;
        continue;
      }
      if (kind === END) {
        value += text.slice(pos);
        added += n - pos;
        pos = n;
      } else {
        value += text.slice(pos, end);
        added += end - pos;
        if (kind === COMMA) {
          pos = end + 1;
        } else {
          // LF ends the record; a CR here is one half of a CRLF.
          pos = end + (text.charCodeAt(end) === 13 ? 2 : 1);
          line += 1;
        }
      }
      fValue = value;
      fEnded = kind === 3 ? LINE_BREAK : kind;
      fAdded = added;
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let p = pos + 1;
    let close = -1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) { p = q + 2; continue; }
      close = q;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    let value;
    const innerQ = text.indexOf('"', open + 1);
    const innerR = text.indexOf('\r', open + 1);
    if ((innerQ === -1 || innerQ >= close) && (innerR === -1 || innerR >= close)) {
      // Clean inside: no doubled quotes, no CRs. Slice whole and count
      // the LFs it holds.
      value = text.slice(open + 1, close);
      let idx = open;
      while ((idx = text.indexOf('\n', idx + 1)) !== -1 && idx < close) line += 1;
    } else {
      // Doubled quotes collapse to one; each CRLF or lone CR reads as LF.
      let v = '';
      let seg = open + 1;
      let i = open + 1;
      while (i < close) {
        const ch = text.charCodeAt(i);
        if (ch === 34) {
          v += text.slice(seg, i) + '"';
          i += 2;
          seg = i;
        } else if (ch === 13) {
          v += text.slice(seg, i) + '\n';
          line += 1;
          i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
          seg = i;
        } else {
          if (ch === 10) line += 1;
          i += 1;
        }
      }
      value = v + text.slice(seg, close);
    }
    pos = close + 1;
    if (pos >= n) {
      fValue = value;
      fEnded = END;
      fAdded = 0;
      return;
    }
    const ch = text.charCodeAt(pos);
    if (ch === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      fAdded = 0;
      return;
    }
    if (ch === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const ch = text.charCodeAt(pos);
      if (ch === 10) {
        pos += 1;
        line += 1;
      } else if (ch === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Bulk record path: the record's line holds no quote, so no field on
    // it opens with one, and no stray CR except a CRLF at its end.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const q = text.indexOf('"', pos);
    if (q === -1 || q >= lineEnd) {
      const r = text.indexOf('\r', pos);
      if (r === -1 || r >= lineEnd || (nl !== -1 && r === lineEnd - 1)) {
        const end = nl !== -1 && r === lineEnd - 1 ? lineEnd - 1 : lineEnd;
        const fields = text.slice(pos, end).split(',');
        if (nl === -1) {
          pos = n;
        } else {
          pos = nl + 1;
          line += 1;
        }
        finishRecord(fields);
        continue;
      }
    }

    // Field-by-field path, with bulk splits for runs of unquoted fields.
    const fields = [];
    let lastQuoted = false;
    do {
      let handled = false;
      const nl2 = text.indexOf('\n', pos);
      const le = nl2 === -1 ? n : nl2;
      // The first quote on this line that opens a field: one at the
      // field's start, or right after a comma. Any other quote is a
      // literal inside an unquoted field.
      let q2 = text.indexOf('"', pos);
      while (q2 !== -1 && q2 < le && q2 !== pos && text.charCodeAt(q2 - 1) !== 44) {
        q2 = text.indexOf('"', q2 + 1);
      }
      if (q2 === -1 || q2 >= le) {
        // No quoted field starts on this line: the rest of the record is
        // the rest of the line, unless a stray CR hides in it.
        const r2 = text.indexOf('\r', pos);
        if (r2 === -1 || r2 >= le || (nl2 !== -1 && r2 === le - 1)) {
          const end = nl2 !== -1 && r2 === le - 1 ? le - 1 : le;
          const rest = text.slice(pos, end).split(',');
          for (let k = 0; k < rest.length; k++) fields.push(rest[k]);
          lastQuoted = false;
          if (nl2 === -1) {
            pos = n;
            fEnded = END;
          } else {
            pos = nl2 + 1;
            line += 1;
            fEnded = LINE_BREAK;
          }
          handled = true;
        }
      } else if (q2 > pos) {
        // Complete unquoted fields run up to the quoted field, unless a
        // stray CR hides among them.
        const r2 = text.indexOf('\r', pos);
        if (r2 === -1 || r2 >= q2 - 1) {
          const pre = text.slice(pos, q2 - 1).split(',');
          for (let k = 0; k < pre.length; k++) fields.push(pre[k]);
          pos = q2;
          // Fall through: parse the quoted field at pos below.
        } else {
          // A stray CR in the run: parse one field the careful way.
          lastQuoted = false;
          readUnquoted('');
          fields.push(fValue);
          handled = true;
        }
      }
      if (!handled) {
        if (text.charCodeAt(pos) === 34) {
          lastQuoted = true;
          readQuoted();
        } else {
          lastQuoted = false;
          readUnquoted('');
        }
        fields.push(fValue);
      }
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;
    finishRecord(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
