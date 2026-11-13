// Indents JSON text without parsing it into objects, so keys keep their order exactly as sent
// (JSON.parse would move integer-like keys such as option names "10", "2" to the front).
export function prettyJson(text) {
  try {
    JSON.parse(text);
  } catch {
    return text;
  }
  let out = '';
  let depth = 0;
  let inString = false;
  const line = () => `\n${'  '.repeat(depth)}`;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      let j = i + 1;
      while (/\s/.test(text[j] ?? '')) j += 1;
      if (text[j] === close) {
        out += c + close;
        i = j;
      } else {
        depth += 1;
        out += c + line();
      }
    } else if (c === '}' || c === ']') {
      depth -= 1;
      out += line() + c;
    } else if (c === ',') {
      out += c + line();
    } else if (c === ':') {
      out += ': ';
    } else if (!/\s/.test(c)) {
      out += c;
    }
  }
  return out;
}
