package protocol

import (
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"time"
)

const (
	Version           = 1
	Path              = "/v1/fixed-notification"
	MediaType         = "application/vnd.babymonkey.fixed-notification.v1+json"

	MaxRequestBytes  int64 = 128
	MaxResponseBytes int64 = 64

	PastSkew   = 30 * time.Second
	FutureSkew = 5 * time.Second
)

type Outcome string

const (
	Confirmed         Outcome = "confirmed"
	DefinitiveFailure Outcome = "definitive-failure"
	Ambiguous         Outcome = "ambiguous"
)

type Request struct {
	IssuedAt  time.Time
	ReplayKey [32]byte
}

var canonicalRequestPattern = regexp.MustCompile(
	`^\{"v":1,"issued_at":([1-9][0-9]{9,10}),"replay_key":"([A-Za-z0-9_-]{43})"\}$`,
)

func DecodeRequest(data []byte) (Request, error) {
	match := canonicalRequestPattern.FindSubmatch(data)
	if match == nil {
		return Request{}, errors.New("request is not canonical fixed-notification v1")
	}
	issuedAtUnix, err := strconv.ParseInt(string(match[1]), 10, 64)
	if err != nil {
		return Request{}, errors.New("invalid issued_at")
	}
	issuedAt := time.Unix(issuedAtUnix, 0).UTC()
	encoded := string(match[2])
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(decoded) != 32 {
		return Request{}, errors.New("invalid replay_key")
	}
	if base64.RawURLEncoding.EncodeToString(decoded) != encoded {
		return Request{}, errors.New("replay_key is not canonical")
	}
	var replayKey [32]byte
	copy(replayKey[:], decoded)
	return Request{IssuedAt: issuedAt, ReplayKey: replayKey}, nil
}

func ValidateFreshness(request Request, now time.Time) error {
	if request.IssuedAt.Before(now.Add(-PastSkew)) || request.IssuedAt.After(now.Add(FutureSkew)) {
		return errors.New("request is outside the freshness window")
	}
	return nil
}

func ParseRequest(data []byte, now time.Time) (Request, error) {
	request, err := DecodeRequest(data)
	if err != nil {
		return Request{}, err
	}
	if err := ValidateFreshness(request, now); err != nil {
		return Request{}, err
	}
	return request, nil
}

func ResponseBody(outcome Outcome) ([]byte, error) {
	switch outcome {
	case Confirmed, DefinitiveFailure, Ambiguous:
		return []byte(fmt.Sprintf(`{"v":1,"outcome":%q}`, outcome)), nil
	default:
		return nil, errors.New("invalid protocol outcome")
	}
}
