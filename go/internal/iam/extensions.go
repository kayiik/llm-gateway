package iam

import (
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"llmgw/internal/config"
)

// Extension is a companion daemon the gateway reaches the providers it
// serves through, as gateway.db stores it. Its shared secret is not one of
// its fields: listings, responses and audit entries are built from an
// Extension, and only ExtensionCredentialByID and ExtensionCredentials, for
// the gateway's own requests to the daemon, decrypt it.
type Extension struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// ExtensionCreate is an extension to store. An empty ID is derived from the
// name. The caller checks that URL is an address the extension client can
// use; the store only requires one.
type ExtensionCreate struct {
	ID, Name, URL, Secret string
}

// ExtensionUpdate changes the fields of an extension that are not nil. The
// ID never changes: providers name it, and the secret is bound to it.
type ExtensionUpdate struct {
	Name, URL, Secret *string
}

// ExtensionCredential is an extension with its decrypted shared secret, for
// the gateway's own requests to the daemon: never for a response, a log or
// an audit entry. Err says why the secret could not be decrypted, in which
// case Secret is empty; it never contains the secret.
type ExtensionCredential struct {
	Extension
	Secret string
	Err    error
}

var (
	// ErrExtensionExists refuses an ID another extension holds.
	ErrExtensionExists = errors.New("an extension with this ID already exists")
	// ErrExtensionNotFound reports an ID no extension holds.
	ErrExtensionNotFound = errors.New("extension not found")
)

// InvalidExtensionError is an extension the store refuses, saying what to
// change.
type InvalidExtensionError struct{ Message string }

func (e *InvalidExtensionError) Error() string { return e.Message }

func invalidExtension(message string) error { return &InvalidExtensionError{Message: message} }

// extensionIDPattern is an extension's ID: a lowercase slug, which travels
// unescaped in provider settings, admin routes and the associated data its
// secret is bound to.
var extensionIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

const (
	maxExtensionIDLength  = 63
	maxExtensionNameRunes = 200
	// maxExtensionURLLength and maxExtensionSecretLength bound what an
	// administrator enters, far beyond any daemon's address or secret.
	maxExtensionURLLength    = 2048
	maxExtensionSecretLength = 4096
)

// extensionAAD binds an extension's sealed secret to its ID, so a ciphertext
// copied to another extension does not decrypt there.
func extensionAAD(id string) []byte {
	return []byte("extension|" + id + "|v1")
}

// extensionSecretKey returns the key an extension's secret is sealed with.
// Without one the secret is refused rather than stored in plaintext.
func extensionSecretKey() ([]byte, error) {
	if strings.TrimSpace(config.Get().CredentialEncryptionKey) == "" {
		return nil, fmt.Errorf(
			"%w: LLMGW_CREDENTIAL_ENCRYPTION_KEY is required to store an extension's secret, which is never stored in plaintext",
			ErrCredentialEncryptionNotConfigured,
		)
	}
	return credentialKey()
}

func checkExtensionID(id string) error {
	if !extensionIDPattern.MatchString(id) {
		return invalidExtension("id must be 1 to 63 lowercase letters, digits, '-' or '_', starting with a letter or digit")
	}
	return nil
}

func checkExtensionName(name string) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", invalidExtension("name is required")
	case utf8.RuneCountInString(name) > maxExtensionNameRunes:
		return "", invalidExtension(fmt.Sprintf("name must be at most %d characters", maxExtensionNameRunes))
	}
	return name, nil
}

func checkExtensionURL(url string) (string, error) {
	url = strings.TrimSpace(url)
	switch {
	case url == "":
		return "", invalidExtension("url is required")
	case len(url) > maxExtensionURLLength:
		return "", invalidExtension(fmt.Sprintf("url must be at most %d bytes", maxExtensionURLLength))
	}
	return url, nil
}

// checkExtensionSecret returns the secret as the extension client sends it,
// trimmed. A daemon started without a secret serves anyone who reaches it,
// so the gateway requires one.
func checkExtensionSecret(secret string) (string, error) {
	secret = strings.TrimSpace(secret)
	switch {
	case secret == "":
		return "", invalidExtension("a shared secret is required: start the daemon with one and enter the same one here")
	case len(secret) > maxExtensionSecretLength:
		return "", invalidExtension(fmt.Sprintf("the shared secret must be at most %d bytes", maxExtensionSecretLength))
	}
	return secret, nil
}

// extensionSlug derives an ID from name: its ASCII letters and digits,
// lowercased, each run of anything else turned into one '-', cut to the
// longest ID. A name with neither gives "extension".
func extensionSlug(name string) string {
	var slug strings.Builder
	separated := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			slug.WriteRune(r)
			separated = false
		case slug.Len() > 0 && !separated:
			slug.WriteByte('-')
			separated = true
		}
	}
	derived := strings.TrimRight(slug.String(), "-")
	if len(derived) > maxExtensionIDLength {
		derived = strings.TrimRight(derived[:maxExtensionIDLength], "-")
	}
	if derived == "" {
		return "extension"
	}
	return derived
}

func extensionExists(tx *sql.Tx, id string) (bool, error) {
	var found int
	err := tx.QueryRow("SELECT 1 FROM extensions WHERE id=?", id).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// freeExtensionID returns base, or base with the lowest suffix from "-2" on
// that no extension holds, cut so that it stays an ID.
func freeExtensionID(tx *sql.Tx, base string) (string, error) {
	for attempt := 1; ; attempt++ {
		candidate := base
		if attempt > 1 {
			suffix := "-" + strconv.Itoa(attempt)
			candidate = strings.TrimRight(base[:min(len(base), maxExtensionIDLength-len(suffix))], "-_") + suffix
		}
		taken, err := extensionExists(tx, candidate)
		if err != nil || !taken {
			return candidate, err
		}
	}
}

// CreateExtension stores an extension, its secret sealed with the credential
// encryption key. Without the key nothing is stored.
func CreateExtension(input ExtensionCreate) (Extension, error) {
	id := strings.TrimSpace(input.ID)
	if id != "" {
		if err := checkExtensionID(id); err != nil {
			return Extension{}, err
		}
	}
	name, err := checkExtensionName(input.Name)
	if err != nil {
		return Extension{}, err
	}
	url, err := checkExtensionURL(input.URL)
	if err != nil {
		return Extension{}, err
	}
	secret, err := checkExtensionSecret(input.Secret)
	if err != nil {
		return Extension{}, err
	}
	key, err := extensionSecretKey()
	if err != nil {
		return Extension{}, err
	}
	db, err := DB()
	if err != nil {
		return Extension{}, err
	}
	tx, err := db.Begin()
	if err != nil {
		return Extension{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if id == "" {
		// The ID is chosen inside the transaction that takes it, since the
		// secret is sealed for it.
		id, err = freeExtensionID(tx, extensionSlug(name))
		if err != nil {
			return Extension{}, err
		}
	} else {
		taken, err := extensionExists(tx, id)
		if err != nil {
			return Extension{}, err
		}
		if taken {
			return Extension{}, ErrExtensionExists
		}
	}
	ciphertext, nonce, err := encryptCredential(key, []byte(secret), extensionAAD(id))
	if err != nil {
		return Extension{}, err
	}
	now := time.Now().Unix()
	if _, err := tx.Exec(`
INSERT INTO extensions(id,name,url,ciphertext,nonce,key_version,created_at,updated_at)
VALUES(?,?,?,?,?,1,?,?)`, id, name, url, ciphertext, nonce, now, now); err != nil {
		return Extension{}, err
	}
	if err := tx.Commit(); err != nil {
		return Extension{}, err
	}
	return Extension{ID: id, Name: name, URL: url, CreatedAt: now, UpdatedAt: now}, nil
}

// UpdateExtension changes the fields update carries, and returns the
// extension and the names of the fields that changed. A secret it carries is
// sealed again and reported as changed whatever it was: comparing it with the
// stored one would tell whoever sends it whether it matched.
func UpdateExtension(id string, update ExtensionUpdate) (Extension, []string, error) {
	id = strings.TrimSpace(id)
	var name, url, secret string
	var err error
	if update.Name != nil {
		if name, err = checkExtensionName(*update.Name); err != nil {
			return Extension{}, nil, err
		}
	}
	if update.URL != nil {
		if url, err = checkExtensionURL(*update.URL); err != nil {
			return Extension{}, nil, err
		}
	}
	var key []byte
	if update.Secret != nil {
		if secret, err = checkExtensionSecret(*update.Secret); err != nil {
			return Extension{}, nil, err
		}
		if key, err = extensionSecretKey(); err != nil {
			return Extension{}, nil, err
		}
	}
	db, err := DB()
	if err != nil {
		return Extension{}, nil, err
	}
	tx, err := db.Begin()
	if err != nil {
		return Extension{}, nil, err
	}
	defer func() { _ = tx.Rollback() }()
	current, err := scanExtension(tx.QueryRow("SELECT "+extensionColumns+" FROM extensions WHERE id=?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return Extension{}, nil, ErrExtensionNotFound
	}
	if err != nil {
		return Extension{}, nil, err
	}
	next, changed := current, []string{}
	if update.Name != nil && name != current.Name {
		next.Name, changed = name, append(changed, "name")
	}
	if update.URL != nil && url != current.URL {
		next.URL, changed = url, append(changed, "url")
	}
	if update.Secret != nil {
		changed = append(changed, "secret")
	}
	if len(changed) == 0 {
		return current, changed, nil
	}
	next.UpdatedAt = time.Now().Unix()
	if update.Secret != nil {
		ciphertext, nonce, err := encryptCredential(key, []byte(secret), extensionAAD(id))
		if err != nil {
			return Extension{}, nil, err
		}
		_, err = tx.Exec("UPDATE extensions SET name=?,url=?,ciphertext=?,nonce=?,updated_at=? WHERE id=?",
			next.Name, next.URL, ciphertext, nonce, next.UpdatedAt, id)
		if err != nil {
			return Extension{}, nil, err
		}
	} else if _, err := tx.Exec("UPDATE extensions SET name=?,url=?,updated_at=? WHERE id=?",
		next.Name, next.URL, next.UpdatedAt, id); err != nil {
		return Extension{}, nil, err
	}
	if err := tx.Commit(); err != nil {
		return Extension{}, nil, err
	}
	return next, changed, nil
}

// DeleteExtension removes an extension and its secret, and reports whether
// it existed.
func DeleteExtension(id string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result, err := db.Exec("DELETE FROM extensions WHERE id=?", strings.TrimSpace(id))
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected > 0, err
}

const extensionColumns = "id,name,url,created_at,updated_at"

func scanExtension(row rowScanner) (Extension, error) {
	var extension Extension
	err := row.Scan(&extension.ID, &extension.Name, &extension.URL, &extension.CreatedAt, &extension.UpdatedAt)
	return extension, err
}

// ListExtensions returns every extension, by ID, without its secret.
func ListExtensions() ([]Extension, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query("SELECT " + extensionColumns + " FROM extensions ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	extensions := []Extension{}
	for rows.Next() {
		extension, err := scanExtension(rows)
		if err != nil {
			return nil, err
		}
		extensions = append(extensions, extension)
	}
	return extensions, rows.Err()
}

// ExtensionByID returns the extension id names, without its secret.
func ExtensionByID(id string) (Extension, bool, error) {
	db, err := DB()
	if err != nil {
		return Extension{}, false, err
	}
	extension, err := scanExtension(db.QueryRow(
		"SELECT "+extensionColumns+" FROM extensions WHERE id=?", strings.TrimSpace(id),
	))
	if errors.Is(err, sql.ErrNoRows) {
		return Extension{}, false, nil
	}
	return extension, err == nil, err
}

// ExtensionCredentialByID returns the extension id names with its decrypted
// secret; see ExtensionCredential. The error reports only a database that
// could not be read.
func ExtensionCredentialByID(id string) (ExtensionCredential, bool, error) {
	db, err := DB()
	if err != nil {
		return ExtensionCredential{}, false, err
	}
	credential, err := scanExtensionCredential(db.QueryRow(
		"SELECT "+extensionColumns+",ciphertext,nonce FROM extensions WHERE id=?", strings.TrimSpace(id),
	))
	if errors.Is(err, sql.ErrNoRows) {
		return ExtensionCredential{}, false, nil
	}
	return credential, err == nil, err
}

// ExtensionCredentials returns every extension, by ID, with its decrypted
// secret; see ExtensionCredential. A secret that does not decrypt is
// reported on its extension rather than keeping the others from being read.
func ExtensionCredentials() ([]ExtensionCredential, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query("SELECT " + extensionColumns + ",ciphertext,nonce FROM extensions ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	credentials := []ExtensionCredential{}
	for rows.Next() {
		credential, err := scanExtensionCredential(rows)
		if err != nil {
			return nil, err
		}
		credentials = append(credentials, credential)
	}
	return credentials, rows.Err()
}

// scanExtensionCredential reads an extension and opens its secret. A failure
// to open it is kept on the credential, worded without the secret and
// without what the cipher said.
func scanExtensionCredential(row rowScanner) (ExtensionCredential, error) {
	var credential ExtensionCredential
	var ciphertext, nonce []byte
	extension := &credential.Extension
	if err := row.Scan(
		&extension.ID, &extension.Name, &extension.URL, &extension.CreatedAt, &extension.UpdatedAt, &ciphertext, &nonce,
	); err != nil {
		return ExtensionCredential{}, err
	}
	if strings.TrimSpace(config.Get().CredentialEncryptionKey) == "" {
		credential.Err = errors.New("LLMGW_CREDENTIAL_ENCRYPTION_KEY is required to decrypt the extension's secret")
		return credential, nil
	}
	key, err := credentialKey()
	if err != nil {
		credential.Err = err
		return credential, nil
	}
	plaintext, err := decryptCredential(key, ciphertext, nonce, extensionAAD(extension.ID))
	if err != nil {
		credential.Err = errors.New("the extension's secret does not decrypt with the configured credential encryption key")
		return credential, nil
	}
	credential.Secret = string(plaintext)
	return credential, nil
}
