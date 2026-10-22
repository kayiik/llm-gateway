package api

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

const nativeWebsocketLifetime = 30 * time.Minute

func headerToken(header http.Header, name, token string) bool {
	for _, value := range header.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

func validWebsocketUpgrade(r *http.Request) bool {
	key, err := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	return r.Method == http.MethodGet && r.ProtoMajor == 1 &&
		headerToken(r.Header, "Connection", "upgrade") && strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		r.Header.Get("Sec-WebSocket-Version") == "13" && len(r.Header.Values("Sec-WebSocket-Key")) == 1 && err == nil && len(key) == 16
}

func websocketAccept(key string) string {
	// SHA-1 is the RFC 6455 handshake, not credential hashing.
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(sum[:])
}

// relayNativeWebsocket forwards one HTTP upgrade and its opaque byte stream.
// Protocol routing and credential admission happen before it is called. It
// neither parses media/events nor retries, redirects or adapts a live session.
func relayNativeWebsocket(w http.ResponseWriter, r *http.Request, target *url.URL, credentials http.Header, lifetime time.Duration) (int, string) {
	ctx, cancel := context.WithTimeout(r.Context(), lifetime)
	defer cancel()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ForceAttemptHTTP2 = false
	transport.ResponseHeaderTimeout = 15 * time.Second
	defer transport.CloseIdleConnections()
	status, code := http.StatusBadGateway, "upstream"
	proxy := httputil.ReverseProxy{
		Transport: transport,
		ErrorLog:  log.New(io.Discard, "", 0),
		Rewrite: func(p *httputil.ProxyRequest) {
			*p.Out.URL = *target
			p.Out.Host = target.Host
			p.Out.Header = credentials.Clone()
			for _, name := range []string{"Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Extensions", "OpenAI-Beta"} {
				if values := p.In.Header.Values(name); len(values) != 0 {
					p.Out.Header[name] = append([]string(nil), values...)
				}
			}
			p.Out.Header.Set("Connection", "Upgrade")
			p.Out.Header.Set("Upgrade", "websocket")
			p.Out.Header.Set("User-Agent", "llmgw")
		},
		ModifyResponse: func(response *http.Response) error {
			if response.StatusCode == http.StatusSwitchingProtocols {
				extensions := response.Header.Get("Sec-WebSocket-Extensions")
				if !strings.EqualFold(response.Header.Get("Upgrade"), "websocket") || !headerToken(response.Header, "Connection", "upgrade") ||
					response.Header.Get("Sec-WebSocket-Accept") != websocketAccept(r.Header.Get("Sec-WebSocket-Key")) ||
					response.Header.Get("Sec-WebSocket-Protocol") != "" || (extensions != "" && r.Header.Get("Sec-WebSocket-Extensions") == "") {
					return errors.New("invalid upstream WebSocket handshake")
				}
				response.Header = http.Header{
					"Connection": {"Upgrade"}, "Upgrade": {"websocket"},
					"Sec-Websocket-Accept": {response.Header.Get("Sec-WebSocket-Accept")},
					"X-Llmgw-Usage-Scope":  {"unobserved_session"},
				}
				// Compression is negotiated end to end; the relay never decodes frames.
				if extensions != "" {
					response.Header.Set("Sec-WebSocket-Extensions", extensions)
				}
				status, code = http.StatusSwitchingProtocols, ""
				return nil
			}
			status = response.StatusCode
			if status < 400 || status > 599 {
				status = http.StatusBadGateway
			}
			retryAfter := safeRetryAfter(response.Header.Get("Retry-After"))
			_ = response.Body.Close()
			const body = `{"error":{"message":"realtime WebSocket upstream handshake failed","type":"upstream_error"}}`
			response.StatusCode = status
			response.Body = io.NopCloser(strings.NewReader(body))
			response.ContentLength = int64(len(body))
			response.TransferEncoding = nil
			response.Header = http.Header{"Content-Type": {"application/json"}}
			if retryAfter != "" {
				response.Header.Set("Retry-After", retryAfter)
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			status, code = http.StatusBadGateway, "upstream"
			if r.Context().Err() != nil {
				status, code = 499, "client_cancelled"
				return
			}
			writeError(w, status, "realtime WebSocket upstream handshake failed")
		},
	}
	proxy.ServeHTTP(w, r.WithContext(ctx))
	if r.Context().Err() != nil {
		code = "client_cancelled"
	} else if ctx.Err() != nil {
		code = "session_deadline"
	}
	return status, code
}
