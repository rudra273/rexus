package backup

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Backup files are named rexus-YYYYMMDD-HHMMSS.dump (UTC), so sorting the
// names sorts them by time. Anything else in the folder is never touched.
var fileRe = regexp.MustCompile(`^rexus-(\d{8})-(\d{6})\.dump$`)

const timeLayout = "20060102-150405"

// File is one backup found on disk.
type File struct {
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

// Files lists the backups in the folder, newest first. A missing folder is not an error.
func (s *Service) Files() ([]File, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []File{}, nil
		}
		return nil, err
	}
	out := []File{}
	for _, e := range entries {
		m := fileRe.FindStringSubmatch(e.Name())
		if m == nil || e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		created, err := time.Parse(timeLayout, m[1]+"-"+m[2])
		if err != nil {
			created = info.ModTime()
		}
		out = append(out, File{Name: e.Name(), SizeBytes: info.Size(), CreatedAt: created})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name > out[j].Name })
	return out, nil
}

// Rotate deletes the oldest backups so that only the newest `keep` remain.
func (s *Service) Rotate(keep int) ([]string, error) {
	files, err := s.Files()
	if err != nil {
		return nil, err
	}
	var removed []string
	for i, f := range files {
		if i < keep {
			continue
		}
		if err := os.Remove(filepath.Join(s.dir, f.Name)); err != nil && !os.IsNotExist(err) {
			return removed, fmt.Errorf("can't remove old backup %s: %s", f.Name, reason(err))
		}
		removed = append(removed, f.Name)
	}
	return removed, nil
}

// freeName picks a file name that isn't taken, moving forward a second at a
// time if two backups would land in the same second.
func (s *Service) freeName(t time.Time) string {
	for {
		name := "rexus-" + t.UTC().Format(timeLayout) + ".dump"
		_, e1 := os.Stat(filepath.Join(s.dir, name))
		_, e2 := os.Stat(filepath.Join(s.dir, name+".partial"))
		if os.IsNotExist(e1) && os.IsNotExist(e2) {
			return name
		}
		t = t.Add(time.Second)
	}
}

// cleanPartials removes half-written files left by a crash.
func (s *Service) cleanPartials() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "rexus-") && strings.HasSuffix(e.Name(), ".dump.partial") {
			os.Remove(filepath.Join(s.dir, e.Name()))
		}
	}
}

// ResolveFile turns a file name chosen in the UI into a path inside the backup
// folder. It accepts only real backup names — never a path.
func (s *Service) ResolveFile(name string) (string, error) {
	if filepath.Base(name) != name || !fileRe.MatchString(name) {
		return "", errors.New("that is not a Rexus backup file name")
	}
	path := filepath.Join(s.dir, name)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("backup file not found")
	}
	return path, nil
}

// CheckDir returns a short problem description if the backup folder can't be
// used (missing, read-only, drive unplugged), or "" if all is well.
func (s *Service) CheckDir() string {
	if s.dir == "" {
		return "REXUS_BACKUP_DIR is not set"
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Sprintf("can't create the folder %s: %s", s.dir, reason(err))
	}
	probe := filepath.Join(s.dir, ".rexus-write-test")
	f, err := os.OpenFile(probe, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Sprintf("can't write to the folder %s: %s", s.dir, reason(err))
	}
	f.Close()
	os.Remove(probe)
	return ""
}
