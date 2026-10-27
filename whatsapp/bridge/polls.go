package main

// Polls: remembering them and reading the votes back.
//
// A WhatsApp poll is two kinds of message. The poll itself (PollCreationMessage,
// in one of several protobuf versions) carries the question and option names in
// the clear. Each vote is a separate PollUpdateMessage whose payload is
// encrypted with the poll's message secret, and which names its choices only as
// SHA-256 hashes of the option names. So reading a vote needs two things kept
// from the poll: the secret (whatsmeow stores it itself, for polls we receive
// and polls we send) and the option names (stored here, in `polls`).
//
// Each voter's latest vote replaces their previous one, exactly as WhatsApp
// shows it: a vote with no options selected is a retracted vote.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/binary/proto"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func initPollTables(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS polls (
			id TEXT,
			chat_jid TEXT,
			creator TEXT,
			question TEXT,
			options TEXT,            -- JSON array of option names, in order
			selectable_count INTEGER, -- 0 = any number, 1 = single choice
			created_at TIMESTAMP,
			PRIMARY KEY (id, chat_jid)
		);
		CREATE TABLE IF NOT EXISTS poll_votes (
			poll_id TEXT,
			chat_jid TEXT,
			voter TEXT,              -- sender user part, same key as messages.sender
			options TEXT,            -- JSON array of chosen option names; [] = retracted
			updated_at TIMESTAMP,
			PRIMARY KEY (poll_id, chat_jid, voter)
		);
	`)
	return err
}

// pollCreation returns the poll inside a message, whichever version carries it.
func pollCreation(msg *waProto.Message) *waProto.PollCreationMessage {
	if msg == nil {
		return nil
	}
	for _, p := range []*waProto.PollCreationMessage{
		msg.GetPollCreationMessage(),
		msg.GetPollCreationMessageV2(),
		msg.GetPollCreationMessageV3(),
		msg.GetPollCreationMessageV5(),
		msg.GetPollCreationMessageV6(),
	} {
		if p != nil {
			return p
		}
	}
	return nil
}

// pollText is how a poll reads in the message store, so history, search and the
// previews all see it as the question and its options.
func pollText(p *waProto.PollCreationMessage) string {
	var b strings.Builder
	b.WriteString("📊 POLL: ")
	b.WriteString(p.GetName())
	if p.GetSelectableOptionsCount() != 1 {
		b.WriteString(" (multiple choice)")
	}
	for _, o := range p.GetOptions() {
		b.WriteString("\n• ")
		b.WriteString(o.GetOptionName())
	}
	return b.String()
}

// StorePoll remembers a poll's options so later votes can be read. A poll never
// changes once sent, so the first copy wins.
func (store *MessageStore) StorePoll(id, chatJID, creator string, p *waProto.PollCreationMessage, at time.Time) error {
	names := make([]string, 0, len(p.GetOptions()))
	for _, o := range p.GetOptions() {
		names = append(names, o.GetOptionName())
	}
	opts, _ := json.Marshal(names)
	_, err := store.db.Exec(
		`INSERT OR IGNORE INTO polls (id, chat_jid, creator, question, options, selectable_count, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, chatJID, creator, p.GetName(), string(opts), p.GetSelectableOptionsCount(), at,
	)
	return err
}

func (store *MessageStore) pollOptions(id, chatJID string) ([]string, error) {
	var raw string
	err := store.db.QueryRow("SELECT options FROM polls WHERE id = ? AND chat_jid = ?", id, chatJID).Scan(&raw)
	if err != nil {
		return nil, err
	}
	var names []string
	err = json.Unmarshal([]byte(raw), &names)
	return names, err
}

// StoreVote keeps each voter's latest vote. Votes can arrive out of order after
// a reconnect, so an older one never overwrites a newer one.
func (store *MessageStore) StoreVote(pollID, chatJID, voter string, chosen []string, at time.Time) error {
	opts, _ := json.Marshal(chosen)
	_, err := store.db.Exec(
		`INSERT INTO poll_votes (poll_id, chat_jid, voter, options, updated_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT (poll_id, chat_jid, voter) DO UPDATE SET options = excluded.options, updated_at = excluded.updated_at
		 WHERE excluded.updated_at >= poll_votes.updated_at`,
		pollID, chatJID, voter, string(opts), at,
	)
	return err
}

// handlePollVote decrypts one vote and records which options it chose.
func handlePollVote(client *whatsmeow.Client, store *MessageStore, msg *events.Message, logger waLog.Logger) {
	update := msg.Message.GetPollUpdateMessage()
	pollID := update.GetPollCreationMessageKey().GetID()
	chatJID := msg.Info.Chat.String()
	voter := msg.Info.Sender.User

	vote, err := client.DecryptPollVote(context.Background(), msg)
	if err != nil {
		// No secret means a poll from before this device was linked, or one
		// whose creation we never saw. Nothing to do but note it.
		logger.Warnf("Poll vote on %s in %s could not be decrypted: %v", pollID, chatJID, err)
		return
	}

	names, err := store.pollOptions(pollID, chatJID)
	if err != nil && err != sql.ErrNoRows {
		logger.Warnf("Failed to read options for poll %s: %v", pollID, err)
	}
	byHash := make(map[string]string, len(names))
	for _, n := range names {
		h := sha256.Sum256([]byte(n))
		byHash[string(h[:])] = n
	}
	chosen := []string{}
	for _, h := range vote.GetSelectedOptions() {
		if n, ok := byHash[string(h)]; ok {
			chosen = append(chosen, n)
		} else {
			// Poll options unknown (created before polls were recorded).
			chosen = append(chosen, "?"+hex.EncodeToString(h)[:8])
		}
	}

	if err := store.StoreVote(pollID, chatJID, voter, chosen, msg.Info.Timestamp); err != nil {
		logger.Warnf("Failed to store poll vote: %v", err)
		return
	}
	fmt.Printf("[%s] poll %s: %s voted %v\n", msg.Info.Timestamp.Format("2006-01-02 15:04:05"), pollID, voter, chosen)
}
