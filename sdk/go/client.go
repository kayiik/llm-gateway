// Package llmgwclient calls a live gateway first and uses application-selected
// local targets only when the gateway cannot be reached.
package llmgwclient

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var paths = map[string]string{"chat": "/v1/chat/completions", "responses": "/v1/responses", "messages": "/v1/messages"}

type CallError struct{ Status int }

func (e *CallError) Error() string { return fmt.Sprintf("upstream returned HTTP %d", e.Status) }

type UnsupportedRequest struct{ Reason string }

func (e *UnsupportedRequest) Error() string { return e.Reason }

type Target struct {
	Provider  string `json:"provider,omitempty"`
	Model     string `json:"model"`
	Dialect   string `json:"dialect"`
	BaseURL   string `json:"base_url"`
	APIKey    string `json:"api_key"`
	ExpiresAt int64  `json:"expires_at,omitempty"`
}
type Selector struct {
	Targets         []string `json:"targets"`
	Ingress         []string `json:"ingress,omitempty"`
	AllowAdaptation bool     `json:"allow_adaptation"`
}
type Snapshot struct {
	Version     int                 `json:"version"`
	FetchedUnix float64             `json:"fetched_unix"`
	CacheOwner  string              `json:"cache_owner"`
	Selectors   map[string]Selector `json:"selectors"`
	Targets     map[string]Target   `json:"targets"`
}

type CallResult struct {
	Data   map[string]any
	Source string
	Target string
}

type Client struct {
	URL                  string
	Key                  string
	CachePath            string
	LocalTargets         func(selector, dialect string) []string
	ShouldTryNext        func(error, string) bool
	IsGatewayUnavailable func(error) bool
	HTTPClient           *http.Client
	StreamIdleTimeout    time.Duration
	mu                   sync.Mutex
	snapshot             *Snapshot
	refreshing           bool
	lastAttempt          time.Time
}

func New(url, key, cachePath string, localTargets func(string, string) []string) (*Client, error) {
	c := &Client{URL: strings.TrimRight(url, "/"), Key: key, CachePath: cachePath,
		LocalTargets: localTargets, HTTPClient: &http.Client{Timeout: 30 * time.Second}, StreamIdleTimeout: 30 * time.Second}
	if data, err := os.ReadFile(cachePath); err == nil {
		var snapshot Snapshot
		if err = json.Unmarshal(data, &snapshot); err != nil || snapshot.Version != 1 {
			return nil, fmt.Errorf("invalid saved client snapshot: %v", err)
		}
		if snapshot.CacheOwner != c.cacheOwner() {
			return nil, errors.New("saved snapshot belongs to a different gateway or key")
		}
		c.snapshot = &snapshot
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return c, nil
}

func (c *Client) cacheOwner() string {
	sum := sha256.Sum256([]byte(c.URL + "\x00" + c.Key))
	return hex.EncodeToString(sum[:])
}

func (c *Client) request(ctx context.Context, url, key, dialect string, body map[string]any) (map[string]any, error) {
	method := http.MethodGet
	var payload io.Reader
	if body != nil {
		method = http.MethodPost
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if dialect == "messages" && body != nil {
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &CallError{resp.StatusCode}
	}
	var answer map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil {
		return nil, &UnsupportedRequest{"upstream response is not valid JSON"}
	}
	if answer == nil {
		return nil, &UnsupportedRequest{"upstream response is not a JSON object"}
	}
	return answer, nil
}

func (c *Client) Refresh(ctx context.Context) error {
	answer, err := c.request(ctx, c.URL+"/v1/client-snapshot", c.Key, "chat", nil)
	if err != nil {
		return err
	}
	data, err := json.Marshal(answer)
	if err != nil {
		return err
	}
	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return err
	}
	if snapshot.Version != 1 || snapshot.Selectors == nil || snapshot.Targets == nil {
		return errors.New("unsupported client snapshot")
	}
	snapshot.FetchedUnix = float64(time.Now().Unix())
	snapshot.CacheOwner = c.cacheOwner()
	data, err = json.Marshal(snapshot)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(c.CachePath), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(c.CachePath), ".snapshot-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), c.CachePath); err != nil {
		return err
	}
	c.mu.Lock()
	c.snapshot = &snapshot
	c.mu.Unlock()
	return nil
}

func (c *Client) refreshIfStale() {
	c.mu.Lock()
	stale := c.snapshot == nil || time.Since(time.Unix(int64(c.snapshot.FetchedUnix), 0)) > time.Hour
	if !stale || c.refreshing || time.Since(c.lastAttempt) < time.Minute {
		c.mu.Unlock()
		return
	}
	c.refreshing = true
	c.lastAttempt = time.Now()
	c.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = c.Refresh(ctx)
		c.mu.Lock()
		c.refreshing = false
		c.mu.Unlock()
	}()
}

func (c *Client) Call(ctx context.Context, dialect, selector string, body map[string]any) (map[string]any, error) {
	result, err := c.CallWithInfo(ctx, dialect, selector, body)
	return result.Data, err
}

func (c *Client) CallWithInfo(ctx context.Context, dialect, selector string, body map[string]any) (CallResult, error) {
	path, ok := paths[dialect]
	if !ok {
		return CallResult{}, errors.New("unknown caller dialect")
	}
	if body["stream"] == true {
		return CallResult{}, &UnsupportedRequest{"use Stream() for streaming output"}
	}
	c.refreshIfStale()
	input := make(map[string]any, len(body)+1)
	for k, v := range body {
		input[k] = v
	}
	input["model"] = selector
	answer, err := c.request(ctx, c.URL+path, c.Key, dialect, input)
	if err == nil {
		return CallResult{Data: answer, Source: "gateway"}, nil
	}
	var op *net.OpError
	var upstream *CallError
	proxyOutage := errors.As(err, &upstream) && (upstream.Status == 502 || upstream.Status == 503 || upstream.Status == 504) && c.IsGatewayUnavailable != nil && c.IsGatewayUnavailable(err)
	if !proxyOutage && (!errors.As(err, &op) || op.Op != "dial") {
		return CallResult{}, err
	}
	c.mu.Lock()
	snapshot := c.snapshot
	c.mu.Unlock()
	if snapshot == nil {
		return CallResult{}, errors.New("gateway unavailable and no local snapshot is saved")
	}
	entry, ok := snapshot.Selectors[selector]
	if !ok {
		return CallResult{}, errors.New("selector is not available in the saved snapshot")
	}
	if len(entry.Ingress) > 0 {
		permitted := false
		for _, allowed := range entry.Ingress {
			if allowed == path {
				permitted = true
				break
			}
		}
		if !permitted {
			return CallResult{}, &UnsupportedRequest{"this route does not permit the caller dialect"}
		}
	}
	allowed := map[string]bool{}
	for _, id := range entry.Targets {
		allowed[id] = true
	}
	if c.LocalTargets == nil {
		return CallResult{}, errors.New("no local targets were selected")
	}
	var last error
	for _, id := range c.LocalTargets(selector, dialect) {
		last = nil
		if !allowed[id] {
			return CallResult{}, errors.New("local target is not permitted for this selector")
		}
		target, ok := snapshot.Targets[id]
		if !ok {
			return CallResult{}, errors.New("local target is missing from snapshot")
		}
		if paths[target.Dialect] == "" {
			return CallResult{}, &UnsupportedRequest{"unknown target dialect"}
		}
		var outbound map[string]any
		if target.ExpiresAt > 0 && time.Now().Unix() >= target.ExpiresAt {
			last = &UnsupportedRequest{"local credential has expired"}
		} else if target.Dialect == dialect {
			outbound = make(map[string]any, len(input))
			for k, v := range input {
				outbound[k] = v
			}
			outbound["model"] = target.Model
		} else if !entry.AllowAdaptation {
			last = &UnsupportedRequest{"conversion is not allowed for this selector"}
		} else {
			turns, limit, convErr := readTurns(dialect, input)
			if convErr == nil {
				outbound, convErr = encode(target.Dialect, target.Model, turns, limit)
			}
			last = convErr
		}
		if last == nil {
			root := strings.TrimRight(target.BaseURL, "/")
			if !strings.HasSuffix(root, "/v1") {
				root += "/v1"
			}
			answer, last = c.request(ctx, root+paths[target.Dialect][3:], target.APIKey, target.Dialect, outbound)
			if last == nil {
				if target.Dialect == dialect {
					return CallResult{Data: answer, Source: "direct", Target: id}, nil
				}
				var value string
				value, last = readText(target.Dialect, answer)
				if last == nil {
					return CallResult{Data: decode(dialect, selector, value, answer), Source: "direct", Target: id}, nil
				}
			}
		}
		if c.ShouldTryNext == nil || !c.ShouldTryNext(last, id) {
			return CallResult{}, last
		}
	}
	if last != nil {
		return CallResult{}, last
	}
	return CallResult{}, errors.New("no local targets were selected")
}
