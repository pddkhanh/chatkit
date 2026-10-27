// chatkit search engine — textnorm.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
const TEXTNORM_VERSION = 1;
const TEEN = new Map(
  Object.entries({
    ko: "không",
    hok: "không",
    khum: "không",
    hông: "không",
    hem: "không",
    dc: "được",
    đc: "được",
    vk: "vợ",
    vs: "với",
    bik: "biết",
    mún: "muốn",
    đag: "đang",
    xog: "xong",
    nhiu: "nhiêu",
    nhìu: "nhiều",
    lun: "luôn",
    nge: "nghe",
    ngta: "người ta",
    ng: "người",
    ae: "anh em",
    mn: "mọi người",
    cty: "công ty",
    zô: "vô",
    zìa: "về",
    dìa: "về",
    zui: "vui",
    zụ: "vụ",
    zì: "gì",
    zữ: "dữ",
    zậy: "vậy",
    zị: "vậy",
    trc: "trước",
    ntn: "như thế nào",
    đt: "điện thoại",
    sdt: "số điện thoại"
  })
);
const SHORT_FORMS = /* @__PURE__ */ new Map();
for (const [short, full] of TEEN) {
  for (const w of full.split(" ")) SHORT_FORMS.set(w, [...SHORT_FORMS.get(w) ?? [], short]);
}
const shortFormsOf = (word) => SHORT_FORMS.get(word) ?? [];
const WORD_RE = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;
const UNSPACED_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const isUnspaced = (s) => UNSPACED_RE.test(String(s ?? ""));
const TONE_RE = /[̣̀́̉̃]/;
function placeTone(tok) {
  const m = /([ou])([aey])([̣̀́̉̃])$/u.exec(tok.normalize("NFD"));
  if (!m) return tok;
  const d = tok.normalize("NFD");
  const head = d.slice(0, m.index);
  const pair = `${m[1]}${m[2]}`;
  if (pair !== "oa" && pair !== "oe" && pair !== "uy") return tok;
  if (m[1] === "u" && /q$/.test(head)) return tok;
  if (/[̛̂̆]$/.test(head)) return tok;
  return `${head}${m[1]}${m[3]}${m[2]}`.normalize("NFC");
}
function mapToken(tok, teen) {
  if (teen) {
    const t = TEEN.get(tok);
    if (t !== void 0) return t;
  }
  if (tok.length < 2 || tok.charCodeAt(tok.length - 1) < 192) return tok;
  return TONE_RE.test(tok.normalize("NFD")) ? placeTone(tok) : tok;
}
function exact(text, { teen = true } = {}) {
  const s = String(text ?? "").normalize("NFC").toLowerCase();
  return s.replace(WORD_RE, (tok) => mapToken(tok, teen));
}
const foldExact = (e) => String(e ?? "").normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").normalize("NFC");
function fold(text, opts) {
  return foldExact(exact(text, opts));
}
const tokens = (s) => String(s ?? "").match(WORD_RE) ?? [];
const hasAccents = (text) => {
  const e = exact(text);
  return e !== fold(text);
};
export {
  TEXTNORM_VERSION,
  WORD_RE,
  exact,
  fold,
  foldExact,
  hasAccents,
  isUnspaced,
  shortFormsOf,
  tokens
};
