//go:build !linux

package httpapi

import "time"

func fileBirthTime(_ string, fallback time.Time) time.Time {
	return fallback
}
