// chatkit search engine — searchplatform.js. Generated from the upstream engine with comments
// removed; edit upstream, not here. MIT licence (see LICENSE).
import * as db from "./db.js";
const PLATFORM = "telegram";
const WORDS_VARIANT = "";
const TEEN_POLICY = "all";
const chatName = (jid) => db.getChat(jid)?.name ?? null;
const contactName = (sender) => db.displayName(sender);
export {
  PLATFORM,
  TEEN_POLICY,
  WORDS_VARIANT,
  chatName,
  contactName
};
