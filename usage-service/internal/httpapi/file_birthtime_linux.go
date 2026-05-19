//go:build linux

package httpapi

import (
	"time"

	"golang.org/x/sys/unix"
)

func fileBirthTime(path string, fallback time.Time) time.Time {
	var stat unix.Statx_t
	if err := unix.Statx(unix.AT_FDCWD, path, unix.AT_SYMLINK_NOFOLLOW, unix.STATX_BTIME, &stat); err == nil {
		if stat.Mask&unix.STATX_BTIME != 0 && stat.Btime.Sec > 0 {
			return time.Unix(stat.Btime.Sec, int64(stat.Btime.Nsec))
		}
	}
	return fallback
}
