// sentenceCase writes a value the gateway reports, such as "needs_credentials"
// or "active", as a label: its words apart, the first capitalised and the
// rest as they are. Labels are written in sentence case where they are made;
// the stylesheet does not recase them.
export function sentenceCase(value: string): string {
  const words = value.replaceAll("_", " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : words;
}
