package main

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// Edits and deletes ("delete for everyone").
//
// WhatsApp delivers both as a ProtocolMessage that points at an earlier message
// by id. They carry no text and no media of their own, so before this file
// handleMessage dropped them on the floor: a deleted message sat in the store
// looking perfectly normal, and nothing could answer "what did they delete?".
//
// The rule here is that the ORIGINAL IS NEVER OVERWRITTEN. `content` stays
// exactly what arrived first. An edit lands in edited_content (the latest edit
// wins) and a delete only stamps deleted_at. Keeping what someone deleted is
// the point, not a side effect.

func initRevisionColumns(db *sql.DB) error {
	for _, ddl := range []string{
		"ALTER TABLE messages ADD COLUMN deleted_at TIMESTAMP",
		"ALTER TABLE messages ADD COLUMN deleted_by TEXT",
		"ALTER TABLE messages ADD COLUMN edited_at TIMESTAMP",
		"ALTER TABLE messages ADD COLUMN edited_content TEXT",
	} {
		if _, err := db.Exec(ddl); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("%s: %v", ddl, err)
		}
	}
	return nil
}

// handleRevision records an edit or delete and reports whether msg was one, so
// handleMessage can stop there. Any other protocol message returns false and
// falls through exactly as before (it has no content, so it is dropped).
func handleRevision(client *whatsmeow.Client, store *MessageStore, msg *events.Message, logger waLog.Logger) bool {
	pm := msg.Message.GetProtocolMessage()
	if pm == nil {
		return false
	}
	targetID := pm.GetKey().GetID()
	chatJID := msg.Info.Chat.String()
	by := msg.Info.Sender.User
	byAlt := msg.Info.SenderAlt.User
	ts := msg.Info.Timestamp.Format("2006-01-02 15:04:05")

	switch pm.GetType() {
	case waProto.ProtocolMessage_REVOKE:
		if targetID == "" {
			return true
		}
		chat, err := store.MarkDeleted(targetID, chatJID, by, byAlt, msg.Info.Timestamp)
		if err != nil {
			logger.Warnf("Failed to record delete of %s: %v", targetID, err)
			return true
		}
		if chat == "" {
			fmt.Printf("[%s] ✗ %s deleted %s (not in the store)\n", ts, by, targetID)
			return true
		}
		fmt.Printf("[%s] ✗ %s deleted %s — original kept\n", ts, by, targetID)
		// A deleted photo or video is only worth keeping if the bytes are kept
		// too. WhatsApp's CDN is not obliged to serve them once the sender has
		// revoked the message, so fetch them now rather than on first request.
		// downloadMedia is a no-op for a text message and for a file already
		// on disk.
		go func() {
			if ok, mediaType, _, path, err := downloadMedia(client, store, targetID, chat); ok {
				fmt.Printf("Kept deleted %s at %s\n", mediaType, path)
			} else if err != nil && !strings.Contains(err.Error(), "not a media message") {
				fmt.Printf("Could not keep the media of deleted message %s: %v\n", targetID, err)
			}
		}()
		return true

	case waProto.ProtocolMessage_MESSAGE_EDIT:
		text := extractTextContent(pm.GetEditedMessage())
		if targetID == "" || text == "" {
			return true
		}
		chat, err := store.MarkEdited(targetID, chatJID, by, byAlt, msg.Info.IsFromMe, text, msg.Info.Timestamp)
		if err != nil {
			logger.Warnf("Failed to record edit of %s: %v", targetID, err)
		} else if chat == "" {
			fmt.Printf("[%s] ✎ %s edited %s (not in the store, or not theirs)\n", ts, by, targetID)
		} else {
			fmt.Printf("[%s] ✎ %s edited %s: %s\n", ts, by, targetID, text)
		}
		return true
	}
	return false
}

// revisionTarget finds the chat a revision's target row lives in.
//
// Normally that is the chat the revision arrived in. A DM, though, can be
// addressed by phone number on one event and by LID on the next, so when the
// same-chat lookup misses, fall back to the id alone — but only to a row the
// reviser actually sent, so a revision from one chat can never touch a message
// in another chat that belongs to someone else.
func (store *MessageStore) revisionTarget(id, chatJID, by, byAlt string) (string, error) {
	var chat string
	err := store.db.QueryRow(
		"SELECT chat_jid FROM messages WHERE id = ? AND chat_jid = ?", id, chatJID,
	).Scan(&chat)
	if err == nil {
		return chat, nil
	}
	if err != sql.ErrNoRows {
		return "", err
	}
	rows, err := store.db.Query(
		"SELECT chat_jid FROM messages WHERE id = ? AND sender IN (?, ?) LIMIT 2", id, by, byAlt,
	)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var found []string
	for rows.Next() {
		if err := rows.Scan(&chat); err != nil {
			return "", err
		}
		found = append(found, chat)
	}
	if len(found) != 1 {
		return "", rows.Err()
	}
	return found[0], rows.Err()
}

// MarkDeleted stamps a message as deleted and returns the chat it lives in, or
// "" when the store never had it. The first delete wins; content is untouched.
//
// Who deleted is recorded but not checked: in a group an admin may delete
// anyone's message, so the deleter legitimately differs from the sender. A
// forged delete could only ever add this stamp — never remove anything.
func (store *MessageStore) MarkDeleted(id, chatJID, by, byAlt string, at time.Time) (string, error) {
	chat, err := store.revisionTarget(id, chatJID, by, byAlt)
	if chat == "" || err != nil {
		return "", err
	}
	_, err = store.db.Exec(
		`UPDATE messages SET deleted_at = COALESCE(deleted_at, ?), deleted_by = COALESCE(deleted_by, ?)
		 WHERE id = ? AND chat_jid = ?`,
		at, nullIfEmpty(by), id, chat,
	)
	return chat, err
}

// MarkEdited records the latest edit beside the original and returns the chat,
// or "" when there is no such message or the editor is not its sender. Only a
// message's own sender can edit it, so an edit from anyone else is ignored.
func (store *MessageStore) MarkEdited(id, chatJID, by, byAlt string, fromMe bool, text string, at time.Time) (string, error) {
	chat, err := store.revisionTarget(id, chatJID, by, byAlt)
	if chat == "" || err != nil {
		return "", err
	}
	res, err := store.db.Exec(
		`UPDATE messages SET edited_content = ?, edited_at = ?
		 WHERE id = ? AND chat_jid = ? AND (sender IN (?, ?) OR (is_from_me AND ?))`,
		text, at, id, chat, by, byAlt, fromMe,
	)
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", nil
	}
	return chat, nil
}
