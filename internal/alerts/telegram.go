package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"rexus/internal/store"
)

type telegramChannel struct {
	channel *store.AlertChannel
	config  *Config
}

func (s *Service) telegramChannels(ctx context.Context) []telegramChannel {
	channels, err := s.store.ListAlertChannels(ctx, true)
	if err != nil {
		s.log.Warn("alerts: load Telegram channels", "err", err)
		return nil
	}
	var enabled []telegramChannel
	for _, ch := range channels {
		if ch.Type != TypeTelegram {
			continue
		}
		cfg, err := s.DecryptConfig(ch.ConfigEnc)
		if err == nil {
			enabled = append(enabled, telegramChannel{ch, cfg})
		}
	}
	return enabled
}

func (s *Service) startTelegram(ctx context.Context, modules func() SummaryModules) {
	s.wg.Add(2)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				s.sendDailyDigests(ctx, now, modules())
			}
		}
	}()
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		bots := map[string]*telegramBot{}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.pollTelegram(ctx, bots, modules())
			}
		}
	}()
}

func digestKey(schedule *DigestSchedule, now time.Time) string {
	if schedule == nil || schedule.Time == "" {
		return ""
	}
	location, err := time.LoadLocation(schedule.Timezone)
	if err != nil {
		return ""
	}
	local := now.In(location)
	if local.Format("15:04") < schedule.Time {
		return ""
	}
	return "telegram-digest:" + local.Format(time.DateOnly)
}

func (s *Service) sendDailyDigests(ctx context.Context, now time.Time, modules SummaryModules) {
	var summary *Message
	for _, ch := range s.telegramChannels(ctx) {
		key := digestKey(ch.config.Digest, now)
		if key == "" {
			continue
		}
		sent, failures, err := s.store.AlertDeliveryState(ctx, key, ch.channel.ID)
		if err != nil || sent || failures >= maxAttempts {
			continue
		}
		if summary == nil {
			m, err := s.digestSummary(ctx, now, modules)
			if err != nil {
				s.log.Warn("alerts: build daily digest", "err", err)
				return
			}
			summary = &m
		}
		m := *summary
		m.DedupeKey = key
		_ = s.deliver(ctx, m, ch.channel)
	}
}

type telegramBot struct {
	username string
	offset   int64
	retryAt  time.Time
}

type telegramMessage struct {
	Text string `json:"text"`
	Date int64  `json:"date"`
	Chat struct {
		ID int64 `json:"id"`
	} `json:"chat"`
}

type telegramUpdate struct {
	ID          int64            `json:"update_id"`
	Message     *telegramMessage `json:"message"`
	ChannelPost *telegramMessage `json:"channel_post"`
}

func (s *Sender) telegramResult(ctx context.Context, token, method string, params any, result any) error {
	status, body, err := s.post(ctx, s.telegramBase+"/bot"+token+"/"+method, params)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("Telegram %s returned HTTP %d", method, status)
	}
	var response struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
	}
	if json.Unmarshal(body, &response) != nil || !response.OK || json.Unmarshal(response.Result, result) != nil {
		return fmt.Errorf("unexpected Telegram %s response", method)
	}
	return nil
}

func (s *Service) pollTelegram(ctx context.Context, bots map[string]*telegramBot, modules SummaryModules) {
	// Poll each token once, even when it is used by several alert destinations.
	targets := map[string]map[int64]telegramChannel{}
	for _, ch := range s.telegramChannels(ctx) {
		id, err := strconv.ParseInt(deref(ch.config.CommandChatID), 10, 64)
		if err != nil || id == 0 {
			continue
		}
		token := ch.config.BotToken
		if targets[token] == nil {
			targets[token] = map[int64]telegramChannel{}
		}
		targets[token][id] = ch
	}
	for token := range bots {
		if _, enabled := targets[token]; !enabled {
			delete(bots, token)
		}
	}
	var wg sync.WaitGroup
	for token, chats := range targets {
		bot := bots[token]
		if bot == nil {
			bot = &telegramBot{}
			bots[token] = bot
		}
		wg.Go(func() {
			if time.Now().Before(bot.retryAt) {
				return
			}
			if err := s.pollTelegramBot(ctx, token, bot, chats, modules); err != nil && ctx.Err() == nil {
				bot.retryAt = time.Now().Add(time.Minute)
				s.log.Warn("alerts: Telegram commands unavailable", "err", err)
			}
		})
	}
	wg.Wait()
}

func (s *Service) pollTelegramBot(ctx context.Context, token string, bot *telegramBot, chats map[int64]telegramChannel, modules SummaryModules) error {
	if bot.username == "" {
		var me struct {
			Username string `json:"username"`
		}
		if err := s.sender.telegramResult(ctx, token, "getMe", struct{}{}, &me); err != nil {
			return err
		}
		bot.username = me.Username
	}
	var updates []telegramUpdate
	if err := s.sender.telegramResult(ctx, token, "getUpdates", map[string]any{
		"offset": bot.offset, "timeout": 5, "limit": 10,
		"allowed_updates": []string{"message", "channel_post"},
	}, &updates); err != nil {
		return err
	}

	now := time.Now()
	replied := map[int64]bool{}
	for _, update := range updates {
		bot.offset = max(bot.offset, update.ID+1)
		msg := statusRequest(update, bot.username, now, chats)
		if msg == nil || replied[msg.Chat.ID] {
			continue
		}
		ch := chats[msg.Chat.ID]
		replied[msg.Chat.ID] = true
		// Re-read the channel before replying so an edit during polling revokes access.
		current, err := s.store.AlertChannelByID(ctx, ch.channel.ID)
		if err != nil || !current.Enabled || !current.UpdatedAt.Equal(ch.channel.UpdatedAt) {
			continue
		}
		m, _, err := s.statusSummary(ctx, now, modules)
		if err != nil {
			s.log.Warn("alerts: build Telegram status", "err", err)
			m = Message{Headline: "Rexus status unavailable", Severity: "warning", Link: s.base()}
		}
		cfg := &Config{BotToken: token, ChatID: strconv.FormatInt(msg.Chat.ID, 10)}
		if err := s.sender.Send(ctx, TypeTelegram, cfg, m); err != nil {
			s.log.Warn("alerts: Telegram status reply failed", "err", err)
		}
	}
	return nil
}

func statusRequest(update telegramUpdate, bot string, now time.Time, chats map[int64]telegramChannel) *telegramMessage {
	msg := update.Message
	if msg == nil {
		msg = update.ChannelPost
	}
	if msg == nil || !isStatusCommand(msg.Text, bot) {
		return nil
	}
	age := now.Sub(time.Unix(msg.Date, 0))
	if _, allowed := chats[msg.Chat.ID]; !allowed || age > 2*time.Minute || age < -time.Minute {
		return nil
	}
	return msg
}

func isStatusCommand(text, bot string) bool {
	command, username, addressed := strings.Cut(strings.TrimSpace(text), "@")
	return command == "/status" && (!addressed || (bot != "" && strings.EqualFold(username, bot)))
}
