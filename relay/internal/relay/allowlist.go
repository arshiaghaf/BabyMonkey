package relay

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
)

type allowlistDocument struct {
	Version              int      `json:"version"`
	CertificateSHA256DER []string `json:"certificate_sha256_der"`
}

func loadAllowlist(path string) (map[string]struct{}, error) {
	data, err := readOwnerOnlyRegularFile(path, 8<<10)
	if err != nil {
		return nil, err
	}
	var document allowlistDocument
	if err := decodeStrictJSON(data, &document); err != nil {
		return nil, err
	}
	if document.Version != 1 || len(document.CertificateSHA256DER) > 2 {
		return nil, errors.New("invalid allowlist version or capacity")
	}
	if !sort.StringsAreSorted(document.CertificateSHA256DER) {
		return nil, errors.New("allowlist fingerprints must be sorted")
	}
	result := make(map[string]struct{}, len(document.CertificateSHA256DER))
	for _, fingerprint := range document.CertificateSHA256DER {
		if len(fingerprint) != sha256.Size*2 {
			return nil, errors.New("invalid certificate fingerprint")
		}
		decoded, err := hex.DecodeString(fingerprint)
		if err != nil || hex.EncodeToString(decoded) != fingerprint {
			return nil, errors.New("invalid certificate fingerprint")
		}
		if _, duplicate := result[fingerprint]; duplicate {
			return nil, errors.New("duplicate certificate fingerprint")
		}
		result[fingerprint] = struct{}{}
	}
	return result, nil
}

func ValidateAllowlist(path string) error {
	_, err := loadAllowlist(path)
	return err
}

// WriteAllowlist replaces the exact-certificate allowlist atomically. It is
// intentionally narrow: at most two leaf fingerprints support controlled A/B
// overlap, and an empty list is an explicit deny-all state.
func WriteAllowlist(path string, fingerprints []string) error {
	if len(fingerprints) > 2 {
		return errors.New("allowlist supports at most two fingerprints")
	}
	copyOfFingerprints := append([]string{}, fingerprints...)
	sort.Strings(copyOfFingerprints)
	document := allowlistDocument{Version: 1, CertificateSHA256DER: copyOfFingerprints}
	seen := map[string]struct{}{}
	for _, fingerprint := range copyOfFingerprints {
		decoded, err := hex.DecodeString(fingerprint)
		if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != fingerprint {
			return errors.New("invalid certificate fingerprint")
		}
		if _, duplicate := seen[fingerprint]; duplicate {
			return errors.New("duplicate certificate fingerprint")
		}
		seen[fingerprint] = struct{}{}
	}
	data, err := json.Marshal(document)
	if err != nil {
		return err
	}
	return writeFileAtomically(path, data)
}

func exactVerifiedClientIdentity(state *tls.ConnectionState) (string, error) {
	if state == nil || len(state.PeerCertificates) == 0 || len(state.VerifiedChains) == 0 {
		return "", errors.New("missing verified client certificate")
	}
	leaf := state.PeerCertificates[0]
	if leaf == nil || len(leaf.Raw) == 0 {
		return "", errors.New("missing verified client leaf")
	}
	sum := sha256.Sum256(leaf.Raw)
	return hex.EncodeToString(sum[:]), nil
}

func LoadClientCAPool(path string) (*x509.CertPool, error) {
	data, err := readOwnerOnlyRegularFile(path, 1<<20)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(data) {
		return nil, errors.New("client CA file contains no certificates")
	}
	return pool, nil
}

func LoadServerCertificate(certificatePath, keyPath string) (tls.Certificate, error) {
	certificatePEM, err := readOwnerOnlyRegularFile(certificatePath, 1<<20)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyPEM, err := readOwnerOnlyRegularFile(keyPath, 1<<20)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(certificatePEM, keyPEM)
}
