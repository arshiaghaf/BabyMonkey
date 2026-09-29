package relay

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	"example.com/babymonkey/relay/internal/protocol"
)

const (
	MaxConcurrency  = 2
	RequestDeadline = 6 * time.Second
)

var errStaleRequest = errors.New("request freshness failed")

type Service struct {
	allowlistFile    string
	replay           *ReplayStore
	notifier         FixedNotifier
	logger           *log.Logger
	semaphore        chan struct{}
	rate             *rateLimiter
	now              func() time.Time
}

func NewService(
	allowlistFile string,
	replay *ReplayStore,
	notifier FixedNotifier,
	logger *log.Logger,
) (*Service, error) {
	if allowlistFile == "" || replay == nil || notifier == nil {
		return nil, errors.New("service dependencies are required")
	}
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	return &Service{
		allowlistFile: allowlistFile,
		replay:        replay,
		notifier:      notifier,
		logger:        logger,
		semaphore:     make(chan struct{}, MaxConcurrency),
		rate:          newRateLimiter(),
		now:           func() time.Time { return time.Now().UTC() },
	}, nil
}

func (service *Service) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	secureHeaders(writer)
	identity, err := exactVerifiedClientIdentity(request.TLS)
	if err != nil {
		service.log("denied_client")
		writeProtocolError(writer, http.StatusForbidden)
		return
	}
	allowlist, err := loadAllowlist(service.allowlistFile)
	if err != nil {
		service.log("allowlist_unavailable")
		writeProtocolError(writer, http.StatusServiceUnavailable)
		return
	}
	if _, allowed := allowlist[identity]; !allowed {
		service.log("unauthorized_certificate")
		writeProtocolError(writer, http.StatusForbidden)
		return
	}
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		writeProtocolError(writer, http.StatusMethodNotAllowed)
		return
	}
	operationPath, mediaType := protocol.Path, protocol.MediaType
	notifier := service.notifier
	reserve, settle := service.replay.Reserve, service.replay.Settle
	writeOutcome := func(outcome protocol.Outcome) { writeOperationOutcome(writer, outcome, mediaType) }
	if request.URL.Path != operationPath {
		writeProtocolError(writer, http.StatusNotFound)
		return
	}
	if request.URL.RawQuery != "" || request.URL.Fragment != "" || request.URL.EscapedPath() != operationPath {
		writeProtocolError(writer, http.StatusBadRequest)
		return
	}
	if !hasExactAuthority(request) {
		writeProtocolError(writer, http.StatusBadRequest)
		return
	}
	if !hasExactSingleHeader(request.Header, "Content-Type", mediaType) {
		writeProtocolError(writer, http.StatusUnsupportedMediaType)
		return
	}
	select {
	case service.semaphore <- struct{}{}:
		defer func() { <-service.semaphore }()
	default:
		service.log("concurrency_limited")
		writeProtocolError(writer, http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), RequestDeadline)
	defer cancel()
	request = request.WithContext(ctx)
	if request.ContentLength > protocol.MaxRequestBytes {
		writeProtocolError(writer, http.StatusRequestEntityTooLarge)
		return
	}
	request.Body = http.MaxBytesReader(writer, request.Body, protocol.MaxRequestBytes)
	data, err := io.ReadAll(request.Body)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			writeProtocolError(writer, http.StatusRequestEntityTooLarge)
		} else {
			writeProtocolError(writer, http.StatusBadRequest)
		}
		return
	}
	if request.ContentLength >= 0 && int64(len(data)) != request.ContentLength {
		writeProtocolError(writer, http.StatusBadRequest)
		return
	}
	now := service.now()
	parsed, err := protocol.DecodeRequest(data)
	if err != nil {
		writeProtocolError(writer, http.StatusBadRequest)
		return
	}
	disposition, err := reserve(parsed.ReplayKey, now, func() error {
		if err := protocol.ValidateFreshness(parsed, now); err != nil {
			return errStaleRequest
		}
		if !service.rate.Allow(identity, now) {
			return errRateLimited
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, errStaleRequest) {
			writeProtocolError(writer, http.StatusBadRequest)
		} else if errors.Is(err, errRateLimited) {
			service.log("rate_limited")
			writeProtocolError(writer, http.StatusTooManyRequests)
		} else {
			service.log("replay_state_unavailable")
			writeProtocolError(writer, http.StatusServiceUnavailable)
		}
		return
	}
	if !disposition.New {
		service.log("replay_" + string(disposition.Outcome))
		writeOutcome(disposition.Outcome)
		return
	}
	outcome := notifier.Send(request.Context())
	if !validOutcome(outcome) {
		outcome = protocol.Ambiguous
	}
	if err := settle(parsed.ReplayKey, outcome); err != nil {
		service.log("settlement_unavailable")
		writeOutcome(protocol.Ambiguous)
		return
	}
	service.log(string(outcome))
	writeOutcome(outcome)
}

func hasExactSingleHeader(header http.Header, name, value string) bool {
	values := header.Values(name)
	return len(values) == 1 && values[0] == value
}

func hasExactAuthority(request *http.Request) bool {
	return request.TLS != nil &&
		request.TLS.ServerName != "" &&
		request.Host == request.TLS.ServerName
}

func secureHeaders(writer http.ResponseWriter) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeProtocolError(writer http.ResponseWriter, status int) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = io.WriteString(writer, `{"error":"unavailable"}`)
}

func writeProtocolOutcome(writer http.ResponseWriter, outcome protocol.Outcome) {
	writeOperationOutcome(writer, outcome, protocol.MediaType)
}

func writeOperationOutcome(writer http.ResponseWriter, outcome protocol.Outcome, mediaType string) {
	body, err := protocol.ResponseBody(outcome)
	if err != nil {
		writeProtocolError(writer, http.StatusServiceUnavailable)
		return
	}
	writer.Header().Set("Content-Type", mediaType)
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(body)
}

func (service *Service) log(outcome string) {
	service.logger.Printf("event=fixed_notification outcome=%s", outcome)
}
