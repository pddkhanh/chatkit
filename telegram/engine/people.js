// chatkit search engine — people.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exact, fold, foldExact, tokens } from "./textnorm.js";
const daemonRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let people = null;
function configurePeople(section) {
  people = section ?? {};
}
function load() {
  if (people) return people;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(daemonRoot, "config.json"), "utf8"));
    people = cfg.people ?? {};
  } catch {
    people = {};
  }
  return people;
}
const key = (s) => tokens(fold(s, { teen: false })).join(" ");
const exactKey = (s) => tokens(exact(s, { teen: false })).join(" ");
const typedAccents = (s) => /[\u0300-\u036f]|đ/i.test(String(s ?? "").normalize("NFD"));
const keyFor = (s) => typedAccents(s) ? exactKey : key;
const HONORIFICS = /* @__PURE__ */ new Set(
  ["a", "anh", "chi", "c", "em", "e", "ku", "thang", "ba", "ong", "co", "chu", "be", "con", "mr", "ms", "mrs"]
);
function bare(k) {
  const t = k.split(" ");
  return t.length > 1 && HONORIFICS.has(foldExact(t[0])) ? t.slice(1).join(" ") : k;
}
const isPerson = (g) => g && typeof g === "object" && typeof g.name === "string" && g.name;
const nameKey = (s) => String(s ?? "").trim().toLowerCase();
function registry(all) {
  const reg = /* @__PURE__ */ new Map();
  for (const g of Array.isArray(all["*"]) ? all["*"] : []) if (isPerson(g)) reg.set(nameKey(g.name), g);
  return reg;
}
function expandEntry(entry, reg) {
  if (typeof entry === "string") return reg.get(nameKey(entry)) ?? null;
  if (entry && typeof entry === "object" && entry.ref) {
    const base = reg.get(nameKey(entry.ref));
    if (!base) return null;
    return {
      ...base,
      aliases: [...base.aliases ?? [], ...entry.aliases ?? []],
      senders: [...base.senders ?? [], ...entry.senders ?? []]
    };
  }
  return isPerson(entry) ? entry : null;
}
function groupsFor(chatJid) {
  const all = load();
  const reg = registry(all);
  let list;
  if (chatJid) list = all[chatJid] ?? all["*"] ?? [];
  else if (all["*"]) list = all["*"];
  else list = Object.values(all).flat();
  return Array.isArray(list) ? list.map((g) => expandEntry(g, reg)).filter(isPerson) : [];
}
function resolvePerson(chatJid, name) {
  const kf = keyFor(name);
  const k = bare(kf(name));
  if (!k) return null;
  for (const g of groupsFor(chatJid)) {
    const all = [g.name, ...g.aliases ?? []];
    if (all.some((a) => bare(kf(a)) === k)) {
      return { ...g, keys: [...new Set(all.map((a) => bare(key(a))))] };
    }
  }
  return null;
}
function aboutParts(about) {
  const out = [];
  for (const raw of String(about ?? "").split(/,|;|\band\b|&/)) {
    const part = raw.trim();
    if (!part) continue;
    const gloss = /\(([^)]*)\)/.exec(part)?.[1];
    out.push(part.replace(/\([^)]*\)/g, " "));
    if (gloss) out.push(...gloss.split("/"));
  }
  return out.map((p) => key(p)).filter(Boolean);
}
function aboutMatcher(chatJid, filter) {
  const person = resolvePerson(chatJid, filter);
  if (person) {
    const keys = person.keys;
    return (about) => aboutParts(about).some((p) => {
      const b = bare(p);
      return keys.some((k) => b === k || b.startsWith(`${k} s `) || b === `${k} s`);
    });
  }
  const kf = keyFor(filter);
  const needle = kf(filter);
  if (!needle) return () => false;
  const re = new RegExp(`(^| )${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
  return (about) => re.test(kf(about));
}
function aboutKeys(chatJid, filter) {
  const person = resolvePerson(chatJid, filter);
  if (person) return { keys: person.keys.filter(Boolean), column: "folded" };
  const accented = typedAccents(filter);
  const k = bare((accented ? exactKey : key)(filter));
  return { keys: k ? [k] : [], column: accented ? "exact" : "folded" };
}
function personSenders(chatJid, name) {
  const p = resolvePerson(chatJid, name);
  return p?.senders?.length ? p.senders.map(String) : null;
}
function personForSender(chatJid, key2) {
  const k = String(key2 ?? "").split("@")[0];
  if (!k) return null;
  for (const g of groupsFor(chatJid)) {
    if ((g.senders ?? []).some((s) => String(s).split("@")[0] === k)) return g;
  }
  return null;
}
function peopleOf(chatJid) {
  return groupsFor(chatJid);
}
export {
  aboutKeys,
  aboutMatcher,
  configurePeople,
  peopleOf,
  personForSender,
  personSenders,
  resolvePerson
};
