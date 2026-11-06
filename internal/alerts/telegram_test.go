package alerts

import (
	"testing"
	"time"

	"rexus/internal/store"
)

func TestTelegramStatusAuthorization(t *testing.T) {
	now := time.Date(2026, 11, 6, 9, 0, 0, 0, time.UTC)
	const allowedID = -1001234567890
	chats := map[int64]telegramChannel{allowedID: {}}
	for _, tc := range []struct {
		name, command string
		id            int64
		age           time.Duration
		channel, want bool
	}{
		{"approved group", "/status", allowedID, 0, false, true},
		{"approved channel", "/status", allowedID, 0, true, true},
		{"addressed to bot", "/status@RexusBot", allowedID, 0, false, true},
		{"other chat", "/status", 12345, 0, false, false},
		{"other bot", "/status@OtherBot", allowedID, 0, false, false},
		{"other command", "/start", allowedID, 0, false, false},
		{"old post", "/status", allowedID, 3 * time.Minute, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			msg := &telegramMessage{Text: tc.command, Date: now.Add(-tc.age).Unix()}
			msg.Chat.ID = tc.id
			update := telegramUpdate{Message: msg}
			if tc.channel {
				update = telegramUpdate{ChannelPost: msg}
			}
			if got := statusRequest(update, "rexusbot", now, chats) != nil; got != tc.want {
				t.Fatalf("accepted = %t, want %t", got, tc.want)
			}
		})
	}
}

func TestDigestUsesLocalDateAndTime(t *testing.T) {
	schedule := &DigestSchedule{Time: "09:00", Timezone: "Asia/Kolkata"}
	before := time.Date(2026, 11, 6, 3, 29, 0, 0, time.UTC)
	if got := digestKey(schedule, before); got != "" {
		t.Fatalf("digest due before local 09:00: %q", got)
	}
	at := before.Add(time.Minute)
	if got := digestKey(schedule, at); got != "telegram-digest:2026-11-06" {
		t.Fatalf("unexpected digest key: %q", got)
	}
	if digestKey(schedule, at.Add(time.Hour)) != digestKey(schedule, at) {
		t.Fatal("same local date must use the same deduplication key")
	}
	if digestKey(schedule, at.AddDate(0, 0, 1)) == digestKey(schedule, at) {
		t.Fatal("next local date needs a fresh deduplication key")
	}
}

func TestStatusDoesNotReportStaleCheckAsUp(t *testing.T) {
	now := time.Now()
	checked := now.Add(-10 * time.Minute)
	check := &store.HealthCheck{Status: store.StatusUp, IntervalSeconds: 60, LastCheckedAt: &checked}
	if got := checkStatus(check, now); got != "stale" {
		t.Fatalf("status = %q, want stale", got)
	}
}
