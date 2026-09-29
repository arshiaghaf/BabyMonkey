package main

import (
	"context"
	"crypto/tls"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"example.com/babymonkey/relay/internal/relay"
)

func main() {
	configPath := flag.String("config", "", "path to owner-only relay configuration")
	checkOnly := flag.Bool("check", false, "validate configuration and exit")
	flag.Parse()
	if *configPath == "" || flag.NArg() != 0 {
		log.Fatal("event=startup outcome=invalid_arguments")
	}
	config, err := relay.LoadFileConfig(*configPath)
	if err != nil {
		log.Fatal("event=startup outcome=invalid_config")
	}
	credentials, err := relay.LoadCredentials(config.CredentialsFile)
	if err != nil {
		log.Fatal("event=startup outcome=invalid_credentials")
	}
	clientCAs, err := relay.LoadClientCAPool(config.ClientCAFile)
	if err != nil {
		log.Fatal("event=startup outcome=invalid_client_ca")
	}
	serverCertificate, err := relay.LoadServerCertificate(config.ServerCertificateFile, config.ServerPrivateKeyFile)
	if err != nil {
		log.Fatal("event=startup outcome=invalid_server_certificate")
	}
	replay, err := relay.LoadReplayStore(config.ReplayStateFile)
	if err != nil {
		log.Fatal("event=startup outcome=invalid_replay_state")
	}
	if err := relay.ValidateAllowlist(config.AllowlistFile); err != nil {
		log.Fatal("event=startup outcome=invalid_allowlist")
	}
	if *checkOnly {
		return
	}
	logger := log.New(os.Stdout, "", log.Ldate|log.Ltime|log.LUTC)
	service, err := relay.NewService(config.AllowlistFile, replay, relay.NewTelegramClient(credentials), logger)
	if err != nil {
		log.Fatal("event=startup outcome=invalid_service")
	}
	tlsConfig := &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{serverCertificate},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,
		NextProtos:   []string{"h2", "http/1.1"},
	}
	server := &http.Server{
		Addr:              config.HTTPSListen,
		Handler:           service,
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: time.Second,
		ReadTimeout:       2 * time.Second,
		WriteTimeout:      7 * time.Second,
		IdleTimeout:       10 * time.Second,
		MaxHeaderBytes:    8 << 10,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	serverFailure := make(chan struct{}, 1)
	go func() {
		logger.Print("event=listener outcome=started")
		if err := server.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			serverFailure <- struct{}{}
		}
	}()
	shutdownSignal, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	listenerFailed := false
	select {
	case <-serverFailure:
		listenerFailed = true
		logger.Print("event=listener outcome=failed")
	case <-shutdownSignal.Done():
		logger.Print("event=shutdown outcome=requested")
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	_ = server.Shutdown(shutdownContext)
	cancel()
	stop()
	os.Exit(listenerExitCode(listenerFailed))
}

func listenerExitCode(failed bool) int {
	if failed {
		return 1
	}
	return 0
}
