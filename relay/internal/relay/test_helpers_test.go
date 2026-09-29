package relay

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"example.com/babymonkey/relay/internal/protocol"
)

type fakeNotifier struct {
	outcome protocol.Outcome
	count   atomic.Int64
	block   <-chan struct{}
}

func (notifier *fakeNotifier) Send(ctx context.Context) protocol.Outcome {
	notifier.count.Add(1)
	if notifier.block != nil {
		select {
		case <-notifier.block:
		case <-ctx.Done():
			return protocol.Ambiguous
		}
	}
	return notifier.outcome
}

func testLeaf(t *testing.T, commonName string) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	raw, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(raw)
	if err != nil {
		t.Fatal(err)
	}
	return certificate, key
}

func fingerprint(certificate *x509.Certificate) string {
	sum := sha256.Sum256(certificate.Raw)
	return hex.EncodeToString(sum[:])
}

func verifiedTLS(certificate *x509.Certificate) *tls.ConnectionState {
	return &tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certificate},
		VerifiedChains:   [][]*x509.Certificate{{certificate}},
		ServerName:       "relay.invalid",
	}
}

func writeMode600(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func newReplayStoreForTest(t *testing.T) (*ReplayStore, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "replay.json")
	writeMode600(t, path, []byte(`{"version":1,"entries":[]}`))
	store, err := LoadReplayStore(path)
	if err != nil {
		t.Fatal(err)
	}
	return store, path
}

func testService(t *testing.T, allowed []*x509.Certificate, notifier FixedNotifier) (*Service, *ReplayStore, string) {
	t.Helper()
	directory := t.TempDir()
	allowlistPath := filepath.Join(directory, "allowlist.json")
	fingerprints := make([]string, 0, len(allowed))
	for _, certificate := range allowed {
		fingerprints = append(fingerprints, fingerprint(certificate))
	}
	if err := WriteAllowlist(allowlistPath, fingerprints); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(directory, "replay.json")
	writeMode600(t, statePath, []byte(`{"version":1,"entries":[]}`))
	store, err := LoadReplayStore(statePath)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(allowlistPath, store, notifier, nil)
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return time.Unix(1_787_608_000, 0).UTC() }
	return service, store, allowlistPath
}

func protocolBody(keyByte byte) string {
	key := make([]byte, 32)
	for index := range key {
		key[index] = keyByte
	}
	return `{"v":1,"issued_at":1787608000,"replay_key":"` + base64.RawURLEncoding.EncodeToString(key) + `"}`
}

func ignoredRequestHeaders() http.Header {
	return http.Header{
		"Accept-Encoding":        {"synthetic-transport-encoding"},
		"Authorization":          {"Synthetic synthetic-authorization"},
		"Cf-Connecting-Ip":       {"synthetic-visitor-address"},
		"Cf-Worker":              {"synthetic-worker-metadata"},
		"Connection":             {"keep-alive"},
		"Forwarded":              {"for=synthetic-forwarded"},
		"Telegram-Method":        {"synthetic-telegram-method"},
		"Traceparent":            {"synthetic-trace-context"},
		"X-Arbitrary-Metadata":   {"synthetic-arbitrary-metadata"},
		"X-Bot-Token":            {"synthetic-token-shaped-metadata"},
		"X-Destination":          {"synthetic-destination-metadata"},
		"X-Forwarded-For":        {"synthetic-forwarded-address"},
		"X-Forwarded-Host":       {"synthetic-forwarded-host"},
		"X-Forwarded-Proto":      {"synthetic-forwarded-protocol"},
		"X-Http-Method-Override": {"DELETE"},
		"X-Message":              {"synthetic-message-metadata"},
		"X-Real-Ip":              {"synthetic-real-address"},
		"X-Route":                {"synthetic-route-metadata"},
		"X-Trace":                {"synthetic-trace-metadata"},
		"X-Upstream-Url":         {"https://synthetic.invalid"},
	}
}

func ignoredRequestHeaderValues() []string {
	values := []string{}
	for _, headerValues := range ignoredRequestHeaders() {
		values = append(values, headerValues...)
	}
	return values
}

func invoke(service http.Handler, certificate *x509.Certificate, method, target, body string, headers http.Header) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "https://relay.invalid"+target, strings.NewReader(body))
	request.TLS = verifiedTLS(certificate)
	request.Header.Set("Content-Type", protocol.MediaType)
	request.Header.Set("Accept", protocol.MediaType)
	for name, values := range headers {
		request.Header[name] = values
	}
	response := httptest.NewRecorder()
	service.ServeHTTP(response, request)
	return response
}

func decodeReplayFile(t *testing.T, path string) replayDocument {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document replayDocument
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatal(err)
	}
	return document
}
