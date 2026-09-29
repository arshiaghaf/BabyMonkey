package relay

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/babymonkey/relay/internal/protocol"
)

type responseLossWriter struct {
	header http.Header
	status int
}

type failingRequestBody struct {
	read bool
}

func (body *failingRequestBody) Read(buffer []byte) (int, error) {
	if body.read {
		return 0, errors.New("synthetic body read failure")
	}
	body.read = true
	return copy(buffer, "synthetic"), nil
}

func (*failingRequestBody) Close() error { return nil }

func (writer *responseLossWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = make(http.Header)
	}
	return writer.header
}

func (writer *responseLossWriter) WriteHeader(status int) { writer.status = status }

func (writer *responseLossWriter) Write([]byte) (int, error) {
	return 0, errors.New("synthetic response loss")
}

func TestServiceFixedOperationAndReplay(t *testing.T) {
	certificate, _ := testLeaf(t, "client-a")
	notifier := &fakeNotifier{outcome: protocol.Confirmed}
	service, _, _ := testService(t, []*x509.Certificate{certificate}, notifier)
	first := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(1), nil)
	if first.Code != http.StatusOK || first.Body.String() != `{"v":1,"outcome":"confirmed"}` || notifier.count.Load() != 1 {
		t.Fatalf("first code=%d body=%q sends=%d", first.Code, first.Body.String(), notifier.count.Load())
	}
	second := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(1), ignoredRequestHeaders())
	if second.Code != http.StatusOK || second.Body.String() != first.Body.String() || notifier.count.Load() != 1 {
		t.Fatalf("replay code=%d body=%q sends=%d", second.Code, second.Body.String(), notifier.count.Load())
	}
}

func TestRetainedReplayOutcomeSurvivesRequestFreshnessWindow(t *testing.T) {
	certificate, _ := testLeaf(t, "client")
	notifier := &fakeNotifier{outcome: protocol.Confirmed}
	service, _, _ := testService(t, []*x509.Certificate{certificate}, notifier)
	body := protocolBody(14)
	first := invoke(service, certificate, http.MethodPost, protocol.Path, body, nil)
	if first.Code != http.StatusOK || notifier.count.Load() != 1 {
		t.Fatalf("first code=%d sends=%d", first.Code, notifier.count.Load())
	}
	service.now = func() time.Time {
		return time.Unix(1_787_608_000, 0).UTC().Add(protocol.PastSkew + time.Second)
	}
	replay := invoke(service, certificate, http.MethodPost, protocol.Path, body, nil)
	if replay.Code != http.StatusOK || replay.Body.String() != first.Body.String() || notifier.count.Load() != 1 {
		t.Fatalf("replay code=%d body=%q sends=%d", replay.Code, replay.Body.String(), notifier.count.Load())
	}
	staleNew := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(15), nil)
	if staleNew.Code != http.StatusBadRequest || notifier.count.Load() != 1 {
		t.Fatalf("stale new code=%d sends=%d", staleNew.Code, notifier.count.Load())
	}
}

func TestResponseLossAndSettlementFailureNeverResend(t *testing.T) {
	certificate, _ := testLeaf(t, "client")
	notifier := &fakeNotifier{outcome: protocol.Confirmed}
	service, store, _ := testService(t, []*x509.Certificate{certificate}, notifier)
	request := httptest.NewRequest(http.MethodPost, "https://relay.invalid"+protocol.Path, strings.NewReader(protocolBody(30)))
	request.TLS = verifiedTLS(certificate)
	request.Header.Set("Content-Type", protocol.MediaType)
	request.Header.Set("Accept", protocol.MediaType)
	lost := &responseLossWriter{}
	service.ServeHTTP(lost, request)
	if lost.status != http.StatusOK || notifier.count.Load() != 1 {
		t.Fatalf("lost response status=%d sends=%d", lost.status, notifier.count.Load())
	}
	recovered := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(30), nil)
	if recovered.Code != http.StatusOK || recovered.Body.String() != `{"v":1,"outcome":"confirmed"}` || notifier.count.Load() != 1 {
		t.Fatalf("recovery code=%d body=%q sends=%d", recovered.Code, recovered.Body.String(), notifier.count.Load())
	}

	originalPersist := store.persist
	persistCalls := 0
	store.persist = func(path string, data []byte) error {
		persistCalls++
		if persistCalls == 2 {
			return errors.New("synthetic settlement write failure")
		}
		return originalPersist(path, data)
	}
	uncertain := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(31), nil)
	if uncertain.Code != http.StatusOK || uncertain.Body.String() != `{"v":1,"outcome":"ambiguous"}` || notifier.count.Load() != 2 {
		t.Fatalf("settlement failure code=%d body=%q sends=%d", uncertain.Code, uncertain.Body.String(), notifier.count.Load())
	}
	replayed := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(31), nil)
	if replayed.Code != http.StatusOK || replayed.Body.String() != `{"v":1,"outcome":"ambiguous"}` || notifier.count.Load() != 2 {
		t.Fatalf("failed-settlement replay code=%d body=%q sends=%d", replayed.Code, replayed.Body.String(), notifier.count.Load())
	}
}

func TestServiceSemanticAndBodyGrammarNeverNotifies(t *testing.T) {
	certificate, _ := testLeaf(t, "client")
	notifier := &fakeNotifier{outcome: protocol.Confirmed}
	service, _, _ := testService(t, []*x509.Certificate{certificate}, notifier)
	tests := []struct {
		name    string
		method  string
		target  string
		body    string
		headers http.Header
	}{
		{"method", http.MethodGet, protocol.Path, protocolBody(2), nil},
		{"path", http.MethodPost, "/v1/other", protocolBody(2), nil},
		{"alternate escaped path", http.MethodPost, "/v1/%66ixed-notification", protocolBody(2), nil},
		{"query", http.MethodPost, protocol.Path + "?message=x", protocolBody(2), nil},
		{"unknown field", http.MethodPost, protocol.Path, strings.Replace(protocolBody(2), "}", `,"message":"x"}`, 1), nil},
		{"recipient field", http.MethodPost, protocol.Path, strings.Replace(protocolBody(2), "}", `,"recipient":"x"}`, 1), nil},
		{"destination field", http.MethodPost, protocol.Path, strings.Replace(protocolBody(2), "}", `,"destination":"x"}`, 1), nil},
		{"Telegram method field", http.MethodPost, protocol.Path, strings.Replace(protocolBody(2), "}", `,"telegram_method":"x"}`, 1), nil},
		{"upstream URL field", http.MethodPost, protocol.Path, strings.Replace(protocolBody(2), "}", `,"url":"https://example.invalid"}`, 1), nil},
		{"credential field", http.MethodPost, protocol.Path, strings.Replace(protocolBody(2), "}", `,"token":"x"}`, 1), nil},
		{"duplicate field", http.MethodPost, protocol.Path, strings.Replace(protocolBody(2), `"v":1`, `"v":1,"v":1`, 1), nil},
		{"noncanonical", http.MethodPost, protocol.Path, " " + protocolBody(2), nil},
		{"trailing body content", http.MethodPost, protocol.Path, protocolBody(2) + "\n", nil},
		{"oversized", http.MethodPost, protocol.Path, strings.Repeat("x", 129), nil},
		{"missing content type", http.MethodPost, protocol.Path, protocolBody(2), http.Header{"Content-Type": nil}},
		{"parameterized content type", http.MethodPost, protocol.Path, protocolBody(2), http.Header{"Content-Type": {protocol.MediaType + "; charset=utf-8"}}},
		{"duplicate content type", http.MethodPost, protocol.Path, protocolBody(2), http.Header{"Content-Type": {protocol.MediaType, protocol.MediaType}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := invoke(service, certificate, test.method, test.target, test.body, test.headers)
			if response.Code == http.StatusOK {
				t.Fatalf("unexpected success body=%q", response.Body.String())
			}
		})
	}
	wrongMedia := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(2), http.Header{"Content-Type": {"application/json"}})
	if wrongMedia.Code == http.StatusOK || notifier.count.Load() != 0 {
		t.Fatalf("wrong media code=%d sends=%d", wrongMedia.Code, notifier.count.Load())
	}
	for _, mutate := range []func(*http.Request){
		func(request *http.Request) { request.ContentLength++ },
		func(request *http.Request) { request.Host = "other.invalid" },
		func(request *http.Request) { request.TLS.ServerName = "" },
	} {
		request := httptest.NewRequest(http.MethodPost, "https://relay.invalid"+protocol.Path, strings.NewReader(protocolBody(2)))
		request.TLS = verifiedTLS(certificate)
		request.Header.Set("Content-Type", protocol.MediaType)
		request.Header.Set("Accept", protocol.MediaType)
		mutate(request)
		response := httptest.NewRecorder()
		service.ServeHTTP(response, request)
		if response.Code == http.StatusOK {
			t.Fatalf("unexpected framed-request success body=%q", response.Body.String())
		}
	}
	if notifier.count.Load() != 0 {
		t.Fatalf("invalid grammar invoked notifier %d times", notifier.count.Load())
	}
}

func TestServiceIgnoresUnconsumedHeadersAndAcceptedFraming(t *testing.T) {
	certificate, _ := testLeaf(t, "client")
	notifier := &fakeNotifier{outcome: protocol.Confirmed}
	service, _, _ := testService(t, []*x509.Certificate{certificate}, notifier)

	withMetadata := invoke(
		service,
		certificate,
		http.MethodPost,
		protocol.Path,
		protocolBody(3),
		ignoredRequestHeaders(),
	)
	if withMetadata.Code != http.StatusOK {
		t.Fatalf("metadata request code=%d body=%q", withMetadata.Code, withMetadata.Body.String())
	}

	request := httptest.NewRequest(
		http.MethodPost,
		"https://relay.invalid"+protocol.Path,
		strings.NewReader(protocolBody(4)),
	)
	request.TLS = verifiedTLS(certificate)
	request.Header.Set("Content-Type", protocol.MediaType)
	request.Header["Accept"] = []string{"synthetic-first", "synthetic-second"}
	request.ContentLength = -1
	request.TransferEncoding = []string{"chunked"}
	request.Trailer = http.Header{"X-Synthetic-Trailer": {"synthetic-trailer"}}
	response := httptest.NewRecorder()
	service.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("accepted framing code=%d body=%q", response.Code, response.Body.String())
	}

	withoutAccept := httptest.NewRequest(
		http.MethodPost,
		"https://relay.invalid"+protocol.Path,
		strings.NewReader(protocolBody(5)),
	)
	withoutAccept.TLS = verifiedTLS(certificate)
	withoutAccept.Header.Set("Content-Type", protocol.MediaType)
	withoutAccept.Header.Del("Accept")
	response = httptest.NewRecorder()
	service.ServeHTTP(response, withoutAccept)
	if response.Code != http.StatusOK {
		t.Fatalf("request without Accept code=%d body=%q", response.Code, response.Body.String())
	}

	if notifier.count.Load() != 3 {
		t.Fatalf("notifier calls=%d", notifier.count.Load())
	}
}

func TestBodyReadFailureTruncationAndUnknownLengthOversizeFailClosed(t *testing.T) {
	certificate, _ := testLeaf(t, "client")
	notifier := &fakeNotifier{outcome: protocol.Confirmed}
	service, _, _ := testService(t, []*x509.Certificate{certificate}, notifier)

	readFailure := httptest.NewRequest(http.MethodPost, "https://relay.invalid"+protocol.Path, nil)
	readFailure.TLS = verifiedTLS(certificate)
	readFailure.Header.Set("Content-Type", protocol.MediaType)
	readFailure.Body = &failingRequestBody{}
	readFailure.ContentLength = -1
	response := httptest.NewRecorder()
	service.ServeHTTP(response, readFailure)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("body read failure code=%d", response.Code)
	}

	truncatedBody := protocolBody(6)
	truncated := httptest.NewRequest(
		http.MethodPost,
		"https://relay.invalid"+protocol.Path,
		strings.NewReader(truncatedBody),
	)
	truncated.TLS = verifiedTLS(certificate)
	truncated.Header.Set("Content-Type", protocol.MediaType)
	truncated.ContentLength = int64(len(truncatedBody) + 1)
	response = httptest.NewRecorder()
	service.ServeHTTP(response, truncated)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("truncated body code=%d", response.Code)
	}

	oversized := httptest.NewRequest(
		http.MethodPost,
		"https://relay.invalid"+protocol.Path,
		strings.NewReader(strings.Repeat("x", int(protocol.MaxRequestBytes)+1)),
	)
	oversized.TLS = verifiedTLS(certificate)
	oversized.Header.Set("Content-Type", protocol.MediaType)
	oversized.ContentLength = -1
	response = httptest.NewRecorder()
	service.ServeHTTP(response, oversized)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("unknown-length oversized body code=%d", response.Code)
	}

	if notifier.count.Load() != 0 {
		t.Fatalf("invalid bodies performed %d notifications", notifier.count.Load())
	}
}

func TestCertificateAuthorizationReloadAndDenyAll(t *testing.T) {
	certificateA, _ := testLeaf(t, "client-a")
	certificateB, _ := testLeaf(t, "client-b")
	notifier := &fakeNotifier{outcome: protocol.DefinitiveFailure}
	service, _, allowlistPath := testService(t, []*x509.Certificate{certificateA}, notifier)
	if response := invoke(service, certificateB, http.MethodPost, protocol.Path, protocolBody(3), nil); response.Code != http.StatusForbidden {
		t.Fatalf("unauthorized B code=%d", response.Code)
	}
	if err := WriteAllowlist(allowlistPath, []string{fingerprint(certificateA), fingerprint(certificateB)}); err != nil {
		t.Fatal(err)
	}
	if response := invoke(service, certificateA, http.MethodPost, protocol.Path, protocolBody(4), nil); response.Code != http.StatusOK {
		t.Fatalf("overlap A code=%d", response.Code)
	}
	if response := invoke(service, certificateB, http.MethodPost, protocol.Path, protocolBody(5), nil); response.Code != http.StatusOK {
		t.Fatalf("overlap B code=%d", response.Code)
	}
	if err := WriteAllowlist(allowlistPath, []string{fingerprint(certificateB)}); err != nil {
		t.Fatal(err)
	}
	if response := invoke(service, certificateA, http.MethodPost, protocol.Path, protocolBody(6), nil); response.Code != http.StatusForbidden {
		t.Fatalf("revoked A code=%d", response.Code)
	}
	if response := invoke(service, certificateB, http.MethodPost, protocol.Path, protocolBody(7), nil); response.Code != http.StatusOK {
		t.Fatalf("retained B code=%d", response.Code)
	}
	if err := WriteAllowlist(allowlistPath, nil); err != nil {
		t.Fatal(err)
	}
	if response := invoke(service, certificateB, http.MethodPost, protocol.Path, protocolBody(8), nil); response.Code != http.StatusForbidden {
		t.Fatalf("deny-all B code=%d", response.Code)
	}
	if notifier.count.Load() != 3 {
		t.Fatalf("notifier calls=%d", notifier.count.Load())
	}
}

func TestMissingUnverifiedAndUnavailableAuthorizationFailClosed(t *testing.T) {
	certificate, _ := testLeaf(t, "client")
	notifier := &fakeNotifier{outcome: protocol.Confirmed}
	service, _, allowlistPath := testService(t, []*x509.Certificate{certificate}, notifier)
	for _, state := range []*tls.ConnectionState{nil, {PeerCertificates: []*x509.Certificate{certificate}}} {
		request := httptest.NewRequest(http.MethodPost, "https://relay.invalid"+protocol.Path, strings.NewReader(protocolBody(9)))
		request.Header.Set("Content-Type", protocol.MediaType)
		request.Header.Set("Accept", protocol.MediaType)
		request.TLS = state
		response := httptest.NewRecorder()
		service.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("TLS state %#v code=%d", state, response.Code)
		}
	}
	if err := os.Chmod(allowlistPath, 0o644); err != nil {
		t.Fatal(err)
	}
	if response := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(10), nil); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("permissive allowlist code=%d", response.Code)
	}
	if notifier.count.Load() != 0 {
		t.Fatalf("notifier calls=%d", notifier.count.Load())
	}
}

func TestConcurrentDuplicatesNotifyOnceAndStateFailureNeverNotifies(t *testing.T) {
	certificate, _ := testLeaf(t, "client")
	release := make(chan struct{})
	notifier := &fakeNotifier{outcome: protocol.Confirmed, block: release}
	service, store, _ := testService(t, []*x509.Certificate{certificate}, notifier)
	var wait sync.WaitGroup
	responses := make(chan string, 2)
	for index := 0; index < 2; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			response := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(11), nil)
			responses <- response.Body.String()
		}()
	}
	for notifier.count.Load() == 0 {
		runtime.Gosched()
	}
	close(release)
	wait.Wait()
	close(responses)
	if notifier.count.Load() != 1 {
		t.Fatalf("notifier calls=%d", notifier.count.Load())
	}
	for response := range responses {
		if response != `{"v":1,"outcome":"confirmed"}` && response != `{"v":1,"outcome":"ambiguous"}` {
			t.Fatalf("unexpected response %q", response)
		}
	}

	store.persist = func(string, []byte) error { return errors.New("synthetic write failure") }
	if response := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(12), nil); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("state failure code=%d body=%q", response.Code, response.Body.String())
	}
	if notifier.count.Load() != 1 {
		t.Fatalf("state failure notified: %d", notifier.count.Load())
	}
}

func TestRuntimeReplayStateLossOrCorruptionNeverNotifies(t *testing.T) {
	certificate, _ := testLeaf(t, "client")
	for _, mutate := range []func(*ReplayStore) error{
		func(store *ReplayStore) error { return os.Remove(store.path) },
		func(store *ReplayStore) error {
			return os.WriteFile(store.path, []byte(`{"version":1,"entries":`), 0o600)
		},
		func(store *ReplayStore) error { return os.Chmod(store.path, 0o644) },
	} {
		notifier := &fakeNotifier{outcome: protocol.Confirmed}
		service, store, _ := testService(t, []*x509.Certificate{certificate}, notifier)
		if err := mutate(store); err != nil {
			t.Fatal(err)
		}
		response := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(71), nil)
		if response.Code != http.StatusServiceUnavailable || notifier.count.Load() != 0 {
			t.Fatalf("state mutation code=%d sends=%d", response.Code, notifier.count.Load())
		}
	}
}

func TestLogsUseOnlyCoarseVocabulary(t *testing.T) {
	certificate, _ := testLeaf(t, "sensitive-certificate-label")
	notifier := &fakeNotifier{outcome: protocol.Confirmed}
	service, store, _ := testService(t, []*x509.Certificate{certificate}, notifier)
	var output strings.Builder
	service.logger = log.New(&output, "", 0)
	requestKey := protocolBody(13)
	response := invoke(service, certificate, http.MethodPost, protocol.Path, requestKey, ignoredRequestHeaders())
	if response.Code != http.StatusOK {
		t.Fatalf("code=%d", response.Code)
	}
	if output.String() != "event=fixed_notification outcome=confirmed\n" {
		t.Fatalf("log=%q", output.String())
	}
	replayData, err := os.ReadFile(store.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range append(
		[]string{requestKey, fingerprint(certificate), "sensitive-certificate-label"},
		ignoredRequestHeaderValues()...,
	) {
		if strings.Contains(output.String(), forbidden) || strings.Contains(string(replayData), forbidden) {
			t.Fatalf("logs or replay state contain %q", forbidden)
		}
	}
}

func TestRateLimitBoundsNewFixedOperations(t *testing.T) {
	certificate, _ := testLeaf(t, "client")
	notifier := &fakeNotifier{outcome: protocol.DefinitiveFailure}
	service, _, _ := testService(t, []*x509.Certificate{certificate}, notifier)
	for index := 0; index < RateLimitMax; index++ {
		response := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(byte(40+index)), nil)
		if response.Code != http.StatusOK {
			t.Fatalf("operation %d code=%d", index, response.Code)
		}
	}
	limited := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(60), nil)
	if limited.Code != http.StatusTooManyRequests || notifier.count.Load() != RateLimitMax {
		t.Fatalf("limited code=%d sends=%d", limited.Code, notifier.count.Load())
	}
	// A retained result remains recoverable without consuming new-key capacity.
	replay := invoke(service, certificate, http.MethodPost, protocol.Path, protocolBody(40), nil)
	if replay.Code != http.StatusOK || notifier.count.Load() != RateLimitMax {
		t.Fatalf("replay code=%d sends=%d", replay.Code, notifier.count.Load())
	}
}
