package main

// Emoji reactions arrive as messages that point at an earlier message by id.
// They have no text and no media, and nothing in chatkit reads them, so they
// are recognised and skipped rather than stored as empty messages.

import (
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// handleReaction reports whether msg was a reaction, so handleMessage can stop there.
func handleReaction(client *whatsmeow.Client, store *MessageStore, msg *events.Message, logger waLog.Logger) bool {
	return msg.Message.GetReactionMessage() != nil
}
