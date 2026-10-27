// chatkit — a rough token count for text (the engine sizes its replies with it).
export function estimateTokens(text) {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) ascii++;
    else if (
      (c >= 0x3000 && c <= 0x9fff) || // CJK punctuation, kana, unified ideographs
      (c >= 0xac00 && c <= 0xd7af) || // Hangul
      (c >= 0xf900 && c <= 0xfaff) // CJK compatibility ideographs
    )
      cjk++;
    else other++; // Vietnamese diacritics, accented Latin, emoji
  }
  return Math.round(ascii / 4 + cjk + other / 2);
}
