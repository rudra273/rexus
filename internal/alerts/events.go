// Package alerts sends notifications (Telegram, Slack, Discord, email) when
// something needs attention, and runs the expiry reminders.
package alerts

// Event keys. Which of them actually send anything is configured in the UI.
const (
	EventCheckDown      = "check.down"
	EventCheckRecovered = "check.recovered"
	EventCheckDegraded  = "check.degraded"
	EventSSLExpiring    = "ssl.expiring"
	EventSecretExpiring = "secret.expiring"
	EventJobFailed      = "job.failed"
	EventNewDevice      = "login.new_device"
	EventBackupFailed   = "backup.failed"
)

// EventDef describes one alert event in the settings UI.
type EventDef struct {
	Key            string `json:"key"`
	Label          string `json:"label"`
	Description    string `json:"description"`
	DefaultEnabled bool   `json:"default_enabled"`
	HasDays        bool   `json:"has_days"` // lets the user choose how many days before expiry to remind
}

// Events is the catalog, in display order (plan.md §8.1).
var Events = []EventDef{
	{EventCheckDown, "Site is down", "A health check failed enough times in a row to be marked down.", true, false},
	{EventCheckRecovered, "Site recovered", "A health check that was down is back up.", true, false},
	{EventCheckDegraded, "Site is slow", "A health check responds, but slower than its limit. Off by default — it can be noisy.", false, false},
	{EventSSLExpiring, "SSL certificate expiring", "A certificate enters its warning window (set per check), then again at 7 and 1 days.", true, false},
	{EventSecretExpiring, "Secret / API key expiring", "Reminders before a key's expiry date, and once when it has expired.", true, true},
	{EventJobFailed, "Cron job failed", "A job's run failed. You get one alert when it starts failing, not one per run.", true, false},
	{EventBackupFailed, "Backup failed", "A backup couldn't be written (full disk, drive unplugged…). You get one alert when backups start failing, not one per attempt.", true, false},
	{EventNewDevice, "New login from a new device", "Someone logs in from an IP address or browser they haven't used before.", false, false},
}

// DefaultDays are the key-expiry reminder days used until someone changes them.
var DefaultDays = []int{30, 7, 1}

func EventByKey(key string) (EventDef, bool) {
	for _, e := range Events {
		if e.Key == key {
			return e, true
		}
	}
	return EventDef{}, false
}
