package protocol

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestCanonicalProtocol(t *testing.T) {
	now := time.Unix(1_787_608_000, 0).UTC()
	key := make([]byte, 32)
	for index := range key {
		key[index] = byte(index)
	}
	encoded := base64.RawURLEncoding.EncodeToString(key)
	body := []byte(`{"v":1,"issued_at":1787608000,"replay_key":"` + encoded + `"}`)
	request, err := ParseRequest(body, now)
	if err != nil {
		t.Fatal(err)
	}
	if request.IssuedAt != now || string(request.ReplayKey[:]) != string(key) {
		t.Fatalf("unexpected parsed request: %#v", request)
	}
	for _, outcome := range []Outcome{Confirmed, DefinitiveFailure, Ambiguous} {
		response, err := ResponseBody(outcome)
		if err != nil {
			t.Fatal(err)
		}
		want := `{"v":1,"outcome":"` + string(outcome) + `"}`
		if string(response) != want || int64(len(response)) > MaxResponseBytes {
			t.Fatalf("response=%q want=%q", response, want)
		}
	}
}

func TestRequestRejectsNonCanonicalAndStaleInput(t *testing.T) {
	now := time.Unix(1_787_608_000, 0).UTC()
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	valid := `{"v":1,"issued_at":1787608000,"replay_key":"` + key + `"}`
	tests := []string{
		` {"v":1,"issued_at":1787608000,"replay_key":"` + key + `"}`,
		`{"issued_at":1787608000,"v":1,"replay_key":"` + key + `"}`,
		strings.Replace(valid, `"v":1`, `"v":2`, 1),
		strings.Replace(valid, `"v":1`, `"v":1,"v":1`, 1),
		strings.Replace(valid, `}`, `,"message":"x"}`, 1),
		strings.Replace(valid, `1787608000`, `1787607969`, 1),
		strings.Replace(valid, `1787608000`, `1787608006`, 1),
		strings.Replace(valid, key, "short", 1),
		strings.TrimSuffix(valid, `A"}`) + `B"}`,
		valid + "\n",
	}
	for _, body := range tests {
		if _, err := ParseRequest([]byte(body), now); err == nil {
			t.Fatalf("accepted invalid request %q", body)
		}
	}
}
