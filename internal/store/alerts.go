package store

import (
	"context"
	"time"
)

// ---- channels ----

type AlertChannel struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Name      string    `json:"name"`
	Enabled   bool      `json:"enabled"`
	ConfigEnc []byte    `json:"-"` // encrypted JSON config
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func scanChannel(row interface{ Scan(...any) error }) (*AlertChannel, error) {
	c := &AlertChannel{}
	if err := row.Scan(&c.ID, &c.Type, &c.Name, &c.ConfigEnc, &c.Enabled, &c.CreatedAt, &c.UpdatedAt); err != nil {
		return nil, notFound(err)
	}
	return c, nil
}

const channelCols = `id, type, name, config_enc, enabled, created_at, updated_at`

func (s *Store) ListAlertChannels(ctx context.Context, onlyEnabled bool) ([]*AlertChannel, error) {
	q := `SELECT ` + channelCols + ` FROM alert_channels`
	if onlyEnabled {
		q += ` WHERE enabled`
	}
	rows, err := s.Pool.Query(ctx, q+` ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*AlertChannel{}
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) AlertChannelByID(ctx context.Context, id string) (*AlertChannel, error) {
	return scanChannel(s.Pool.QueryRow(ctx, `SELECT `+channelCols+` FROM alert_channels WHERE id = $1`, id))
}

func (s *Store) CountAlertChannels(ctx context.Context) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM alert_channels`).Scan(&n)
	return n, err
}

func (s *Store) CreateAlertChannel(ctx context.Context, typ, name string, configEnc []byte, enabled bool, createdBy string) (*AlertChannel, error) {
	return scanChannel(s.Pool.QueryRow(ctx, `INSERT INTO alert_channels (type, name, config_enc, enabled, created_by)
		VALUES ($1, $2, $3, $4, $5) RETURNING `+channelCols, typ, name, configEnc, enabled, createdBy))
}

// UpdateAlertChannel changes the name/enabled flag, and the config too when configEnc is non-nil.
func (s *Store) UpdateAlertChannel(ctx context.Context, id, name string, configEnc []byte, enabled bool) (*AlertChannel, error) {
	return scanChannel(s.Pool.QueryRow(ctx, `UPDATE alert_channels SET name = $2, enabled = $4,
			config_enc = COALESCE($3, config_enc), updated_at = now()
		WHERE id = $1 RETURNING `+channelCols, id, name, configEnc, enabled))
}

func (s *Store) DeleteAlertChannel(ctx context.Context, id string) error {
	tag, err := s.Pool.Exec(ctx, `DELETE FROM alert_channels WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- per-event settings ----

type AlertEventSetting struct {
	Event   string         `json:"event"`
	Enabled bool           `json:"enabled"`
	Options map[string]any `json:"options"`
}

// AlertEventSettings returns the events someone has customised; anything
// missing uses its built-in default.
func (s *Store) AlertEventSettings(ctx context.Context) (map[string]AlertEventSetting, error) {
	rows, err := s.Pool.Query(ctx, `SELECT event, enabled, options FROM alert_events`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]AlertEventSetting{}
	for rows.Next() {
		var e AlertEventSetting
		if err := rows.Scan(&e.Event, &e.Enabled, &e.Options); err != nil {
			return nil, err
		}
		if e.Options == nil {
			e.Options = map[string]any{}
		}
		out[e.Event] = e
	}
	return out, rows.Err()
}

func (s *Store) SetAlertEvent(ctx context.Context, event string, enabled bool, options map[string]any) error {
	if options == nil {
		options = map[string]any{}
	}
	_, err := s.Pool.Exec(ctx, `INSERT INTO alert_events (event, enabled, options) VALUES ($1, $2, $3)
		ON CONFLICT (event) DO UPDATE SET enabled = EXCLUDED.enabled, options = EXCLUDED.options, updated_at = now()`,
		event, enabled, options)
	return err
}

// ---- delivery log ----

type AlertRecord struct {
	ID          int64     `json:"id"`
	At          time.Time `json:"at"`
	Event       string    `json:"event"`
	ChannelID   *string   `json:"channel_id"`
	ChannelName string    `json:"channel_name"`
	ProjectKey  *string   `json:"project_key"`
	Title       string    `json:"title"`
	Status      string    `json:"status"` // sent | failed
	Error       *string   `json:"error"`
	DedupeKey   *string   `json:"-"`
}

func (s *Store) RecordAlert(ctx context.Context, r *AlertRecord) error {
	_, err := s.Pool.Exec(ctx, `INSERT INTO alerts_sent (event, channel_id, channel_name, project_key, title, status, error, dedupe_key)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		r.Event, r.ChannelID, r.ChannelName, r.ProjectKey, r.Title, r.Status, r.Error, r.DedupeKey)
	return err
}

func (s *Store) ListAlertRecords(ctx context.Context, limit int) ([]*AlertRecord, error) {
	rows, err := s.Pool.Query(ctx, `SELECT id, at, event, channel_id, channel_name, project_key, title, status, error
		FROM alerts_sent ORDER BY id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*AlertRecord{}
	for rows.Next() {
		r := &AlertRecord{}
		if err := rows.Scan(&r.ID, &r.At, &r.Event, &r.ChannelID, &r.ChannelName, &r.ProjectKey, &r.Title, &r.Status, &r.Error); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AlertDeliveryState says whether a reminder (identified by its dedupe key)
// already reached a channel, and how many times sending to it has failed.
func (s *Store) AlertDeliveryState(ctx context.Context, dedupeKey, channelID string) (sent bool, failures int, err error) {
	err = s.Pool.QueryRow(ctx, `SELECT
			COALESCE(bool_or(status = 'sent'), false),
			count(*) FILTER (WHERE status = 'failed')
		FROM alerts_sent WHERE dedupe_key = $1 AND channel_id = $2`, dedupeKey, channelID).Scan(&sent, &failures)
	return sent, failures, err
}

func (s *Store) PruneAlerts(ctx context.Context, olderThan time.Duration) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM alerts_sent WHERE at < $1`, time.Now().Add(-olderThan))
	return err
}

// KnownDevice reports whether this user has fully logged in before from the
// same IP address and browser (other than the session in excludeSessionID).
func (s *Store) KnownDevice(ctx context.Context, userID, ip, userAgent, excludeSessionID string) (bool, error) {
	if len(userAgent) > 300 {
		userAgent = userAgent[:300]
	}
	var known bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sessions
		WHERE user_id = $1 AND ip = $2 AND user_agent = $3 AND id <> $4 AND mfa_verified)`,
		userID, ip, userAgent, excludeSessionID).Scan(&known)
	return known, err
}
