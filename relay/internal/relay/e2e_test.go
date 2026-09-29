package relay

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"example.com/babymonkey/relay/internal/protocol"
)

type syntheticPKI struct {
	root     *x509.Certificate
	rootPool *x509.CertPool
	server   tls.Certificate
	clientA  tls.Certificate
	clientB  tls.Certificate
	clientC  tls.Certificate
	leafA    *x509.Certificate
	leafB    *x509.Certificate
}

func newSyntheticPKI(t *testing.T) syntheticPKI {
	t.Helper()
	now := time.Now()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "synthetic-local-ca"},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	issue := func(serial int64, commonName string, server bool) (tls.Certificate, *x509.Certificate) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		extendedUse := []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
		dnsNames := []string(nil)
		if server {
			extendedUse = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
			dnsNames = []string{"relay.invalid"}
		}
		template := &x509.Certificate{
			SerialNumber: big.NewInt(serial),
			Subject:      pkix.Name{CommonName: commonName},
			NotBefore:    now.Add(-time.Minute),
			NotAfter:     now.Add(time.Hour),
			KeyUsage:     x509.KeyUsageDigitalSignature,
			ExtKeyUsage:  extendedUse,
			DNSNames:     dnsNames,
		}
		raw, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
		if err != nil {
			t.Fatal(err)
		}
		leaf, err := x509.ParseCertificate(raw)
		if err != nil {
			t.Fatal(err)
		}
		certificate, err := tls.X509KeyPair(
			pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw}),
			pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: mustMarshalECKey(t, key)}),
		)
		if err != nil {
			t.Fatal(err)
		}
		certificate.Leaf = leaf
		return certificate, leaf
	}
	server, _ := issue(2, "synthetic-relay", true)
	clientA, leafA := issue(3, "synthetic-client-a", false)
	clientB, leafB := issue(4, "synthetic-client-b", false)
	clientC, _ := issue(5, "synthetic-client-c", false)
	rootPool := x509.NewCertPool()
	rootPool.AddCert(ca)
	return syntheticPKI{
		root:     ca,
		rootPool: rootPool,
		server:   server,
		clientA:  clientA,
		clientB:  clientB,
		clientC:  clientC,
		leafA:    leafA,
		leafB:    leafB,
	}
}

type workerHarnessDescriptor struct {
	Port              string `json:"port"`
	RootCertificate   string `json:"root_certificate"`
	ClientCertificate string `json:"client_certificate"`
	ClientPrivateKey  string `json:"client_private_key"`
}

// TestWorkerAdapterHarness is dormant unless the dedicated local
// cross-language test supplies a private descriptor path. Keeping the harness
// in a _test.go file makes synthetic behavior unreachable from production
// binaries.
func TestWorkerAdapterHarness(t *testing.T) {
	descriptorPath := os.Getenv("BABYMONKEY_E2E_DESCRIPTOR")
	mode := os.Getenv("BABYMONKEY_E2E_MODE")
	if descriptorPath == "" {
		t.Skip("cross-language harness not requested")
	}
	allowedModes := map[string]bool{
		"confirmed":  true,
		"definitive": true,
		"ambiguous":  true,
		"timeout":    true,
		"malformed":  true,
	}
	if !allowedModes[mode] {
		t.Fatal("invalid synthetic harness mode")
	}
	pki := newSyntheticPKI(t)
	var calls atomic.Int64
	fakeTelegram := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		switch mode {
		case "confirmed":
			_, _ = io.WriteString(writer, `{"ok":true,"result":{}}`)
		case "definitive":
			writer.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(writer, `{"ok":false}`)
		case "ambiguous":
			writer.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(writer, `{"ok":false}`)
		case "malformed":
			_, _ = io.WriteString(writer, `{"ok":`)
		case "timeout":
			time.Sleep(TelegramTimeout + 250*time.Millisecond)
		}
	}))
	defer fakeTelegram.Close()
	telegram := telegramClientForServer(fakeTelegram)
	service, _, _ := testService(t, []*x509.Certificate{pki.leafA}, telegram)
	service.now = func() time.Time { return time.Now().UTC() }
	relayServer := startTLSRelay(t, service, pki)
	key := pki.clientA.PrivateKey.(*ecdsa.PrivateKey)
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := workerHarnessDescriptor{
		Port:              relayServer.Listener.Addr().String()[strings.LastIndex(relayServer.Listener.Addr().String(), ":")+1:],
		RootCertificate:   string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: pki.root.Raw})),
		ClientCertificate: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: pki.clientA.Certificate[0]})),
		ClientPrivateKey:  string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})),
	}
	data, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(descriptorPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(descriptorPath)
	donePath := descriptorPath + ".done"
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(donePath); err == nil {
			_ = os.Remove(donePath)
			if calls.Load() != 1 {
				t.Fatal("expected exactly one synthetic Telegram invocation")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("worker adapter did not complete mode %s", mode)
}

func mustMarshalECKey(t *testing.T, key *ecdsa.PrivateKey) []byte {
	t.Helper()
	data, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func relayHTTPClient(pki syntheticPKI, certificate *tls.Certificate) *http.Client {
	config := &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    pki.rootPool,
		ServerName: "relay.invalid",
	}
	if certificate != nil {
		config.Certificates = []tls.Certificate{*certificate}
	}
	return &http.Client{Transport: &http.Transport{
		TLSClientConfig:   config,
		Proxy:             nil,
		ForceAttemptHTTP2: true,
	}}
}

func startTLSRelay(t *testing.T, service http.Handler, pki syntheticPKI) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(service)
	server.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{pki.server},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pki.rootPool,
		NextProtos:   []string{"h2", "http/1.1"},
	}
	server.EnableHTTP2 = true
	server.Config.ReadHeaderTimeout = time.Second
	server.Config.ReadTimeout = 2 * time.Second
	server.Config.WriteTimeout = 7 * time.Second
	server.Config.MaxHeaderBytes = 8 << 10
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func sendProtocolRequest(t *testing.T, client *http.Client, endpoint, body string) (*http.Response, string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, endpoint+protocol.Path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", protocol.MediaType)
	request.Header.Set("Accept", protocol.MediaType)
	request.Host = "relay.invalid"
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, string(data)
}

func TestLocalEndToEndTLSRelayAndFakeTelegram(t *testing.T) {
	pki := newSyntheticPKI(t)
	var telegramCalls atomic.Int64
	fakeTelegram := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		telegramCalls.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"ok":true,"result":{"message_id":1}}`)
	}))
	defer fakeTelegram.Close()
	telegram := telegramClientForServer(fakeTelegram)
	service, _, allowlistPath := testService(t, []*x509.Certificate{pki.leafA, pki.leafB}, telegram)
	relayServer := startTLSRelay(t, service, pki)

	clientA := relayHTTPClient(pki, &pki.clientA)
	clientB := relayHTTPClient(pki, &pki.clientB)
	clientC := relayHTTPClient(pki, &pki.clientC)
	withoutCertificate := relayHTTPClient(pki, nil)

	response, body := sendProtocolRequest(t, clientA, relayServer.URL, protocolBody(20))
	if response.StatusCode != http.StatusOK || response.ProtoMajor != 2 || body != `{"v":1,"outcome":"confirmed"}` || telegramCalls.Load() != 1 {
		t.Fatalf("A status=%d protocol=%s body=%q Telegram=%d", response.StatusCode, response.Proto, body, telegramCalls.Load())
	}
	response, body = sendProtocolRequest(t, clientA, relayServer.URL, protocolBody(20))
	if response.StatusCode != http.StatusOK || body != `{"v":1,"outcome":"confirmed"}` || telegramCalls.Load() != 1 {
		t.Fatalf("A replay status=%d body=%q Telegram=%d", response.StatusCode, body, telegramCalls.Load())
	}
	response, _ = sendProtocolRequest(t, clientB, relayServer.URL, protocolBody(21))
	if response.StatusCode != http.StatusOK || telegramCalls.Load() != 2 {
		t.Fatalf("B status=%d Telegram=%d", response.StatusCode, telegramCalls.Load())
	}
	response, _ = sendProtocolRequest(t, clientC, relayServer.URL, protocolBody(22))
	if response.StatusCode != http.StatusForbidden || telegramCalls.Load() != 2 {
		t.Fatalf("C status=%d Telegram=%d", response.StatusCode, telegramCalls.Load())
	}
	request, err := http.NewRequest(http.MethodPost, relayServer.URL+protocol.Path, strings.NewReader(protocolBody(23)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", protocol.MediaType)
	request.Header.Set("Accept", protocol.MediaType)
	if _, err := withoutCertificate.Do(request); err == nil {
		t.Fatal("TLS handshake accepted missing client certificate")
	}

	if err := WriteAllowlist(allowlistPath, []string{fingerprint(pki.leafB)}); err != nil {
		t.Fatal(err)
	}
	response, _ = sendProtocolRequest(t, clientA, relayServer.URL, protocolBody(24))
	if response.StatusCode != http.StatusForbidden || telegramCalls.Load() != 2 {
		t.Fatalf("revoked A status=%d Telegram=%d", response.StatusCode, telegramCalls.Load())
	}
	response, _ = sendProtocolRequest(t, clientB, relayServer.URL, protocolBody(25))
	if response.StatusCode != http.StatusOK || telegramCalls.Load() != 3 {
		t.Fatalf("retained B status=%d Telegram=%d", response.StatusCode, telegramCalls.Load())
	}
}

func sendRawTLSRequest(t *testing.T, relayServer *httptest.Server, pki syntheticPKI, raw string) int {
	t.Helper()
	address := strings.TrimPrefix(relayServer.URL, "https://")
	connection, err := tls.Dial("tcp", address, &tls.Config{
		MinVersion:   tls.VersionTLS12,
		RootCAs:      pki.rootPool,
		ServerName:   "relay.invalid",
		Certificates: []tls.Certificate{pki.clientA},
		NextProtos:   []string{"http/1.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection, raw); err != nil {
		t.Fatal(err)
	}
	if err := connection.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPost})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode
}

func TestNetHTTPFramingAuthorityAndHeaderBound(t *testing.T) {
	pki := newSyntheticPKI(t)
	notifier := &fakeNotifier{outcome: protocol.Confirmed}
	service, _, _ := testService(t, []*x509.Certificate{pki.leafA}, notifier)
	relayServer := startTLSRelay(t, service, pki)

	bodyHTTP10 := protocolBody(80)
	status := sendRawTLSRequest(t, relayServer, pki,
		"POST "+protocol.Path+" HTTP/1.0\r\n"+
			"Host: relay.invalid\r\n"+
			"Content-Type: "+protocol.MediaType+"\r\n"+
			"Content-Length: "+strconv.Itoa(len(bodyHTTP10))+"\r\n"+
			"CF-Worker: synthetic-worker-metadata\r\n\r\n"+bodyHTTP10,
	)
	if status != http.StatusOK || notifier.count.Load() != 1 {
		t.Fatalf("HTTP/1.0 status=%d sends=%d", status, notifier.count.Load())
	}

	bodyChunked := protocolBody(81)
	status = sendRawTLSRequest(t, relayServer, pki,
		"POST "+protocol.Path+" HTTP/1.1\r\n"+
			"Host: relay.invalid\r\n"+
			"Content-Type: "+protocol.MediaType+"\r\n"+
			"Content-Length: 1\r\n"+
			"Transfer-Encoding: chunked\r\n"+
			"Trailer: X-Synthetic-Trailer\r\n"+
			"Connection: close\r\n\r\n"+
			strconv.FormatInt(int64(len(bodyChunked)), 16)+"\r\n"+bodyChunked+"\r\n"+
			"0\r\nX-Synthetic-Trailer: synthetic-trailer\r\n\r\n",
	)
	if status != http.StatusOK || notifier.count.Load() != 2 {
		t.Fatalf("chunked status=%d sends=%d", status, notifier.count.Load())
	}

	bodyDuplicateLength := protocolBody(82)
	length := strconv.Itoa(len(bodyDuplicateLength))
	status = sendRawTLSRequest(t, relayServer, pki,
		"POST "+protocol.Path+" HTTP/1.1\r\n"+
			"Host: relay.invalid\r\n"+
			"Content-Type: "+protocol.MediaType+"\r\n"+
			"Content-Length: "+length+"\r\n"+
			"Content-Length: "+length+"\r\n"+
			"Connection: close\r\n\r\n"+bodyDuplicateLength,
	)
	if status != http.StatusOK || notifier.count.Load() != 3 {
		t.Fatalf("duplicate matching Content-Length status=%d sends=%d", status, notifier.count.Load())
	}

	invalidRequests := []struct {
		name string
		raw  string
		want int
	}{
		{
			name: "conflicting content length",
			raw: "POST " + protocol.Path + " HTTP/1.1\r\n" +
				"Host: relay.invalid\r\n" +
				"Content-Type: " + protocol.MediaType + "\r\n" +
				"Content-Length: 1\r\nContent-Length: 2\r\n\r\nx",
			want: http.StatusBadRequest,
		},
		{
			name: "malformed content length",
			raw: "POST " + protocol.Path + " HTTP/1.1\r\n" +
				"Host: relay.invalid\r\n" +
				"Content-Type: " + protocol.MediaType + "\r\n" +
				"Content-Length: synthetic\r\n\r\n",
			want: http.StatusBadRequest,
		},
		{
			name: "malformed chunk",
			raw: "POST " + protocol.Path + " HTTP/1.1\r\n" +
				"Host: relay.invalid\r\n" +
				"Content-Type: " + protocol.MediaType + "\r\n" +
				"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\nsynthetic\r\n",
			want: http.StatusBadRequest,
		},
		{
			name: "oversized body",
			raw: "POST " + protocol.Path + " HTTP/1.1\r\n" +
				"Host: relay.invalid\r\n" +
				"Content-Type: " + protocol.MediaType + "\r\n" +
				"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n81\r\n" +
				strings.Repeat("x", 129) + "\r\n0\r\n\r\n",
			want: http.StatusRequestEntityTooLarge,
		},
		{
			name: "oversized header",
			raw: "POST " + protocol.Path + " HTTP/1.1\r\n" +
				"Host: relay.invalid\r\n" +
				"Content-Type: " + protocol.MediaType + "\r\n" +
				"X-Synthetic-Oversized: " + strings.Repeat("x", 32<<10) + "\r\n\r\n",
			want: http.StatusRequestHeaderFieldsTooLarge,
		},
	}
	for _, test := range invalidRequests {
		t.Run(test.name, func(t *testing.T) {
			if status := sendRawTLSRequest(t, relayServer, pki, test.raw); status != test.want {
				t.Fatalf("status=%d want=%d", status, test.want)
			}
			if notifier.count.Load() != 3 {
				t.Fatalf("invalid framing performed %d notifications", notifier.count.Load())
			}
		})
	}
}

func TestSlowBodyIsTerminatedBeforeNotification(t *testing.T) {
	pki := newSyntheticPKI(t)
	notifier := &fakeNotifier{outcome: protocol.Confirmed}
	service, _, _ := testService(t, []*x509.Certificate{pki.leafA}, notifier)
	relayServer := startTLSRelay(t, service, pki)
	address := strings.TrimPrefix(relayServer.URL, "https://")
	connection, err := tls.Dial("tcp", address, &tls.Config{
		MinVersion:   tls.VersionTLS12,
		RootCAs:      pki.rootPool,
		ServerName:   "relay.invalid",
		Certificates: []tls.Certificate{pki.clientA},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	partialBody := protocolBody(70)[:8]
	_, err = io.WriteString(connection,
		"POST "+protocol.Path+" HTTP/1.1\r\n"+
			"Host: relay.invalid\r\n"+
			"Content-Type: "+protocol.MediaType+"\r\n"+
			"Accept: "+protocol.MediaType+"\r\n"+
			"Content-Length: 100\r\n\r\n"+partialBody,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 256)
	_, readErr := connection.Read(buffer)
	if networkError, ok := readErr.(net.Error); ok && networkError.Timeout() {
		t.Fatal("server did not enforce its read deadline")
	}
	if notifier.count.Load() != 0 {
		t.Fatalf("slow body performed %d notifications", notifier.count.Load())
	}
}
