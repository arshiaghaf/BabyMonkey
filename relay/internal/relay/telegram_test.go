package relay

import (
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"example.com/babymonkey/relay/internal/protocol"
)

func syntheticCredentials() Credentials {
	return Credentials{
		TelegramBotToken: "123456:" + strings.Repeat("A", 32),
		Destination:      "-" + strings.Repeat("7", 12),
		Message:          strings.Join([]string{"synthetic", "fixed", "test"}, " "),
	}
}

func telegramClientForServer(server *httptest.Server) *TelegramClient {
	client := NewTelegramClient(syntheticCredentials())
	client.origin = server.URL
	client.client = server.Client()
	client.client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client
}

func TestTelegramConfirmedUsesOnlyFixedOperation(t *testing.T) {
	credentials := syntheticCredentials()
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/bot"+credentials.TelegramBotToken+"/sendMessage" || request.URL.RawQuery != "" {
			t.Errorf("unexpected request %s %s", request.Method, request.URL.RequestURI())
		}
		if request.Header.Get("Content-Type") != "application/x-www-form-urlencoded" || request.Header.Get("Accept") != "application/json" {
			t.Errorf("unexpected headers %#v", request.Header)
		}
		if err := request.ParseForm(); err != nil {
			t.Error(err)
		}
		if request.Form.Get("chat_id") != credentials.Destination || request.Form.Get("text") != credentials.Message || len(request.Form) != 2 {
			t.Errorf("unexpected fixed form field count=%d", len(request.Form))
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(writer, `{"ok":true,"result":{"message_id":123}}`)
	}))
	defer server.Close()
	client := telegramClientForServer(server)
	client.credentials = credentials
	if outcome := client.Send(t.Context()); outcome != protocol.Confirmed {
		t.Fatalf("outcome=%q", outcome)
	}
}

func TestIgnoredRelayHeadersCannotAlterOrReachTelegramRequest(t *testing.T) {
	credentials := syntheticCredentials()
	var telegramCalls int
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		telegramCalls++
		if request.Method != http.MethodPost || request.URL.Path != "/bot"+credentials.TelegramBotToken+"/sendMessage" || request.URL.RawQuery != "" {
			t.Errorf("unexpected request %s %s", request.Method, request.URL.RequestURI())
		}
		if err := request.ParseForm(); err != nil {
			t.Error(err)
		}
		if request.Form.Get("chat_id") != credentials.Destination || request.Form.Get("text") != credentials.Message || len(request.Form) != 2 {
			t.Errorf("unexpected fixed form field count=%d", len(request.Form))
		}
		for _, forbidden := range ignoredRequestHeaderValues() {
			for _, values := range request.Header {
				for _, value := range values {
					if strings.Contains(value, forbidden) {
						t.Errorf("inbound header value reached Telegram request")
					}
				}
			}
			if strings.Contains(request.URL.String(), forbidden) || strings.Contains(request.Form.Encode(), forbidden) {
				t.Errorf("inbound header value reached Telegram target or form")
			}
		}
		for _, forbiddenName := range []string{
			"Authorization",
			"Cf-Connecting-Ip",
			"Cf-Worker",
			"Forwarded",
			"Telegram-Method",
			"Traceparent",
			"X-Arbitrary-Metadata",
			"X-Bot-Token",
			"X-Destination",
			"X-Forwarded-For",
			"X-Forwarded-Host",
			"X-Forwarded-Proto",
			"X-Http-Method-Override",
			"X-Message",
			"X-Real-Ip",
			"X-Route",
			"X-Trace",
			"X-Upstream-Url",
		} {
			if len(request.Header.Values(forbiddenName)) != 0 {
				t.Errorf("inbound header %s reached Telegram request", forbiddenName)
			}
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"ok":true,"result":{}}`)
	}))
	defer server.Close()
	telegram := telegramClientForServer(server)
	telegram.credentials = credentials
	certificate, _ := testLeaf(t, "client")
	service, _, _ := testService(t, []*x509.Certificate{certificate}, telegram)
	response := invoke(
		service,
		certificate,
		http.MethodPost,
		protocol.Path,
		protocolBody(16),
		ignoredRequestHeaders(),
	)
	if response.Code != http.StatusOK || response.Body.String() != `{"v":1,"outcome":"confirmed"}` || telegramCalls != 1 {
		t.Fatalf("relay code=%d body=%q Telegram=%d", response.Code, response.Body.String(), telegramCalls)
	}
}

func TestTelegramOutcomeMapping(t *testing.T) {
	tests := []struct {
		name        string
		status      int
		contentType string
		response    string
		want        protocol.Outcome
	}{
		{"known 2xx rejection", 200, "application/json", `{"ok":false}`, protocol.DefinitiveFailure},
		{"known 4xx rejection", 400, "application/json; charset=utf-8", `{"ok":false,"description":"synthetic"}`, protocol.DefinitiveFailure},
		{"5xx uncertainty", 500, "application/json", `{"ok":false}`, protocol.Ambiguous},
		{"redirect uncertainty", 302, "application/json", `{"ok":false}`, protocol.Ambiguous},
		{"wrong media", 200, "text/plain", `{"ok":true,"result":{}}`, protocol.Ambiguous},
		{"missing ok", 200, "application/json", `{"result":{}}`, protocol.Ambiguous},
		{"duplicate ok", 200, "application/json", `{"ok":true,"ok":true,"result":{}}`, protocol.Ambiguous},
		{"wrong ok type", 200, "application/json", `{"ok":"true"}`, protocol.Ambiguous},
		{"successful missing result", 200, "application/json", `{"ok":true}`, protocol.Ambiguous},
		{"successful null result", 200, "application/json", `{"ok":true,"result":null}`, protocol.Ambiguous},
		{"successful scalar result", 200, "application/json", `{"ok":true,"result":true}`, protocol.Ambiguous},
		{"successful array result", 200, "application/json", `{"ok":true,"result":[]}`, protocol.Ambiguous},
		{"malformed", 200, "application/json", `{"ok":`, protocol.Ambiguous},
		{"contradictory 4xx", 400, "application/json", `{"ok":true,"result":{}}`, protocol.Ambiguous},
		{"oversized", 200, "application/json", `{"ok":true,"result":"` + strings.Repeat("x", telegramResponseByteLimit) + `"}`, protocol.Ambiguous},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", test.contentType)
				writer.WriteHeader(test.status)
				_, _ = io.WriteString(writer, test.response)
			}))
			defer server.Close()
			if outcome := telegramClientForServer(server).Send(t.Context()); outcome != test.want {
				t.Fatalf("outcome=%q want=%q", outcome, test.want)
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestTelegramTransportErrorsAreAmbiguous(t *testing.T) {
	client := NewTelegramClient(syntheticCredentials())
	client.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("synthetic transport failure")
	})
	if outcome := client.Send(t.Context()); outcome != protocol.Ambiguous {
		t.Fatalf("transport-error outcome=%q", outcome)
	}
}

func TestTelegramTimeoutIsAmbiguousAfterSubmission(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		time.Sleep(100 * time.Millisecond)
	}))
	defer server.Close()
	client := telegramClientForServer(server)
	client.client.Timeout = 25 * time.Millisecond
	if outcome := client.Send(t.Context()); outcome != protocol.Ambiguous {
		t.Fatalf("outcome=%q", outcome)
	}
}
