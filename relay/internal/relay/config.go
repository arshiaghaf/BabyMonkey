package relay

import (
	"errors"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	productionConfigDirectory = "/etc/babymonkey-relay"
	productionStateDirectory  = "/var/lib/babymonkey-relay"
)

type FileConfig struct {
	HTTPSListen           string `json:"https_listen"`
	ServerCertificateFile string `json:"server_certificate_file"`
	ServerPrivateKeyFile  string `json:"server_private_key_file"`
	ClientCAFile          string `json:"client_ca_file"`
	AllowlistFile         string `json:"allowlist_file"`
	CredentialsFile       string `json:"credentials_file"`
	ReplayStateFile       string `json:"replay_state_file"`
}

type Credentials struct {
	TelegramBotToken string `json:"telegram_bot_token"`
	Destination      string `json:"telegram_destination"`
	Message          string `json:"fixed_message"`
}

var (
	botTokenPattern    = regexp.MustCompile(`^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$`)
	destinationPattern = regexp.MustCompile(`^-?[0-9]{1,20}$`)
)

func LoadFileConfig(path string) (FileConfig, error) {
	data, err := readOwnerOnlyRegularFile(path, 16<<10)
	if err != nil {
		return FileConfig{}, err
	}
	var config FileConfig
	if err := decodeStrictJSON(data, &config); err != nil {
		return FileConfig{}, err
	}
	if err := config.ValidateProductionShape(); err != nil {
		return FileConfig{}, err
	}
	return config, nil
}

func (config FileConfig) ValidateProductionShape() error {
	if config.HTTPSListen != ":443" {
		return errors.New("https_listen must be exactly :443")
	}
	for _, path := range []string{
		config.ServerCertificateFile,
		config.ServerPrivateKeyFile,
		config.ClientCAFile,
		config.AllowlistFile,
		config.CredentialsFile,
	} {
		if !pathWithin(path, productionConfigDirectory) {
			return errors.New("configuration file path is outside /etc/babymonkey-relay")
		}
	}
	if !pathWithin(config.ReplayStateFile, productionStateDirectory) {
		return errors.New("replay state path is outside /var/lib/babymonkey-relay")
	}
	return nil
}

func pathWithin(path, directory string) bool {
	if path == "" || !filepath.IsAbs(path) {
		return false
	}
	clean := filepath.Clean(path)
	relative, err := filepath.Rel(directory, clean)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func LoadCredentials(path string) (Credentials, error) {
	data, err := readOwnerOnlyRegularFile(path, 8<<10)
	if err != nil {
		return Credentials{}, err
	}
	var credentials Credentials
	if err := decodeStrictJSON(data, &credentials); err != nil {
		return Credentials{}, err
	}
	if !botTokenPattern.MatchString(credentials.TelegramBotToken) {
		return Credentials{}, errors.New("invalid Telegram bot token shape")
	}
	if !destinationPattern.MatchString(credentials.Destination) {
		return Credentials{}, errors.New("invalid Telegram destination shape")
	}
	if len(credentials.Message) < 1 || len(credentials.Message) > 512 || strings.ContainsAny(credentials.Message, "\x00\r") {
		return Credentials{}, errors.New("fixed message must be 1-512 bytes without NUL or CR")
	}
	return credentials, nil
}
