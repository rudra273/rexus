// Package web embeds the built React UI (web/dist) into the Go binary.
package web

import "embed"

// Dist holds the built UI. Build it with `npm run build` in web/ before
// `go build`; until then only dist/.gitkeep is embedded and the server
// shows a "UI not built" message.
//
//go:embed all:dist
var Dist embed.FS
