package relay

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"example.com/babymonkey/relay/internal/protocol"
)

const (
	telegramOrigin            = "https://api.telegram.org"
	telegramResponseByteLimit = 8 << 10
	TelegramTimeout           = 5 * time.Second
)

type FixedNotifier interface {
	Send(context.Context) protocol.Outcome
}

type TelegramClient struct {
	credentials Credentials
	client      *http.Client
	origin      string
}

func NewTelegramClient(credentials Credentials) *TelegramClient {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	return &TelegramClient{
		credentials: credentials,
		client: &http.Client{
			Transport: transport,
			Timeout:   TelegramTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		origin: telegramOrigin,
	}
}

func (client *TelegramClient) Send(parent context.Context) protocol.Outcome {
	ctx, cancel := context.WithTimeout(parent, TelegramTimeout)
	defer cancel()
	form := url.Values{}
	form.Set("chat_id", client.credentials.Destination)
	form.Set("text", client.credentials.Message)
	requestURL := client.origin + "/bot" + url.PathEscape(client.credentials.TelegramBotToken) + "/sendMessage"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL, strings.NewReader(form.Encode()))
	if err != nil {
		return protocol.DefinitiveFailure
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	response, err := client.client.Do(request)
	if err != nil {
		if response != nil {
			_ = response.Body.Close()
		}
		return protocol.Ambiguous
	}
	defer response.Body.Close()
	if response.StatusCode >= 500 || response.StatusCode >= 300 && response.StatusCode < 400 {
		return protocol.Ambiguous
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return protocol.Ambiguous
	}
	ok, err := parseTelegramOK(response.Body)
	if err != nil {
		return protocol.Ambiguous
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		if ok {
			return protocol.Confirmed
		}
		return protocol.DefinitiveFailure
	}
	if response.StatusCode >= 400 && response.StatusCode < 500 && !ok {
		return protocol.DefinitiveFailure
	}
	return protocol.Ambiguous
}

func parseTelegramOK(reader io.Reader) (bool, error) {
	limited := io.LimitReader(reader, telegramResponseByteLimit+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return false, err
	}
	if len(data) > telegramResponseByteLimit {
		return false, errors.New("Telegram response exceeds limit")
	}
	decoder := json.NewDecoder(bytesReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return false, errors.New("Telegram response is not an object")
	}
	seen := map[string]struct{}{}
	var okValue *bool
	resultIsObject := false
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return false, err
		}
		key, isString := keyToken.(string)
		if !isString {
			return false, errors.New("Telegram response key is invalid")
		}
		if _, duplicate := seen[key]; duplicate {
			return false, errors.New("Telegram response contains duplicate key")
		}
		seen[key] = struct{}{}
		if key == "ok" {
			valueToken, err := decoder.Token()
			value, isBool := valueToken.(bool)
			if err != nil || !isBool {
				return false, errors.New("Telegram ok field is invalid")
			}
			okValue = &value
			continue
		}
		valueToken, err := decoder.Token()
		if err != nil {
			return false, err
		}
		if key == "result" {
			if delimiter, ok := valueToken.(json.Delim); !ok || delimiter != json.Delim('{') {
				return false, errors.New("Telegram result field is not an object")
			}
			resultIsObject = true
		}
		if err := rejectDuplicateKeysAfterToken(decoder, valueToken); err != nil {
			return false, err
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return false, errors.New("Telegram response object is invalid")
	}
	if token, err := decoder.Token(); !errors.Is(err, io.EOF) || token != nil {
		return false, errors.New("Telegram response contains trailing data")
	}
	if okValue == nil {
		return false, errors.New("Telegram response omits ok")
	}
	if *okValue && !resultIsObject {
		return false, errors.New("Telegram successful response omits an object result")
	}
	return *okValue, nil
}
