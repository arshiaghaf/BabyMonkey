package relay

import (
	"errors"
	"sort"
	"sync"
	"time"
)

const (
	RateLimitMax         = 6
	RateLimitWindow      = 60 * time.Second
	RateIdentityCapacity = 4
)

var errRateLimited = errors.New("rate limited")

type rateLimiter struct {
	mu     sync.Mutex
	events map[string][]time.Time
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{events: make(map[string][]time.Time)}
}

func (limiter *rateLimiter) Allow(identity string, now time.Time) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	cutoff := now.Add(-RateLimitWindow)
	for key, existing := range limiter.events {
		firstCurrent := sort.Search(len(existing), func(index int) bool {
			return existing[index].After(cutoff)
		})
		if firstCurrent == len(existing) {
			delete(limiter.events, key)
		} else {
			limiter.events[key] = append(existing[:0], existing[firstCurrent:]...)
		}
	}
	events := limiter.events[identity]
	firstCurrent := sort.Search(len(events), func(index int) bool {
		return events[index].After(cutoff)
	})
	events = append(events[:0], events[firstCurrent:]...)
	if len(events) >= RateLimitMax {
		limiter.events[identity] = events
		return false
	}
	if len(events) == 0 && len(limiter.events) >= RateIdentityCapacity {
		return false
	}
	limiter.events[identity] = append(events, now)
	return true
}
