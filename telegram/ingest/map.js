const SG_OFFSET_MS = 8 * 60 * 60 * 1e3;
function fmtTimestamp(unixSeconds) {
  const sg = new Date(unixSeconds * 1e3 + SG_OFFSET_MS);
  return sg.toISOString().slice(0, 19).replace("T", " ") + "+08:00";
}
function peerId(entity) {
  const id = entity?.id?.value ?? entity?.id;
  if (id === void 0 || id === null) return null;
  const n = typeof id === "bigint" ? id : BigInt(id);
  const cls = entity?.className ?? "";
  if (cls === "Channel" || cls === "ChannelForbidden") return String(-1000000000000n - n);
  if (cls === "Chat" || cls === "ChatForbidden") return String(-n);
  return String(n);
}
const isGroup = (jid) => typeof jid === "string" && jid.startsWith("-");
function displayName(entity) {
  if (!entity) return null;
  if (entity.title) return entity.title;
  const parts = [entity.firstName, entity.lastName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return entity.username ? `@${entity.username}` : null;
}
function mediaOf(msg) {
  const m = msg.media;
  if (!m) return { media_type: "", filename: null, url: null, file_length: null };
  const cls = m.className;
  if (cls === "MessageMediaPhoto") {
    return { media_type: "image", filename: null, url: null, file_length: null };
  }
  if (cls === "MessageMediaDocument") {
    const doc = m.document ?? {};
    const attrs = doc.attributes ?? [];
    const by = (name) => attrs.find((a) => a.className === name);
    const filename = by("DocumentAttributeFilename")?.fileName ?? null;
    const size = doc.size ? Number(doc.size) : null;
    const audio = by("DocumentAttributeAudio");
    const video = by("DocumentAttributeVideo");
    const sticker = by("DocumentAttributeSticker");
    let media_type = "document";
    if (audio) media_type = "audio";
    else if (video) media_type = "video";
    else if (sticker) media_type = "image";
    else if ((doc.mimeType ?? "").startsWith("image/")) media_type = "image";
    return { media_type, filename, url: null, file_length: size };
  }
  if (cls === "MessageMediaWebPage") {
    return { media_type: "", filename: null, url: m.webpage?.url ?? null, file_length: null };
  }
  return { media_type: "document", filename: null, url: null, file_length: null };
}
function contentOf(msg) {
  const text = msg.message ?? "";
  if (text) return text;
  const sticker = msg.media?.document?.attributes?.find(
    (a) => a.className === "DocumentAttributeSticker"
  );
  if (sticker?.alt) return sticker.alt;
  return "";
}
function senderIdOf(msg) {
  const from = msg.fromId;
  if (from) {
    if (from.userId !== void 0) return String(from.userId);
    if (from.channelId !== void 0) return String(-1000000000000n - BigInt(from.channelId));
    if (from.chatId !== void 0) return String(-BigInt(from.chatId));
  }
  return msg.out ? "me" : null;
}
function toRow(msg, chatJid, meId) {
  const media = mediaOf(msg);
  let sender = senderIdOf(msg);
  if (sender === "me") sender = String(meId);
  return {
    id: String(msg.id),
    chat_jid: chatJid,
    sender: sender ?? "",
    content: contentOf(msg),
    timestamp: fmtTimestamp(msg.date),
    is_from_me: msg.out || sender === String(meId) ? 1 : 0,
    media_type: media.media_type,
    filename: media.filename,
    url: media.url,
    file_length: media.file_length,
    quoted_id: msg.replyTo?.replyToMsgId ? String(msg.replyTo.replyToMsgId) : null,
    quoted_sender: null
    // filled by a self-join once the chat is stored
  };
}
export {
  displayName,
  fmtTimestamp,
  isGroup,
  peerId,
  senderIdOf,
  toRow
};
