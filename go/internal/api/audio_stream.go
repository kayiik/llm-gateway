package api

import (
	"bufio"
	"io"
	"net/http"

	"llmgw/internal/providers"
)

type audioProxyWriter struct {
	writer http.ResponseWriter
	err    error
}

func (w *audioProxyWriter) Write(payload []byte) (int, error) {
	w.err = writeAndFlush(w.writer, payload)
	if w.err != nil {
		return 0, w.err
	}
	return len(payload), nil
}

// Audio and transcript SSE are opaque upstream bytes. Flushing each copy keeps
// the existing HTTP proxy incremental without a codec or another SSE dialect.
// abort asks the caller to terminate delivery after recording the outcome:
// neither a JSON error nor a clean EOF can repair a partly delivered audio file.
func writeAudioProxyResponse(w http.ResponseWriter, r *http.Request, response *http.Response, prefix string) (status int, code string, abort bool) {
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		result := readAPIProxyResponse(response, prefix)
		writeUpstreamError(w, result.err)
		return result.status, result.errorCode, false
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	// An immediate upstream read failure can still use the normal safe error
	// envelope. Once bytes are written, only aborting the response is honest.
	if _, err := reader.Peek(1); err != nil && err != io.EOF {
		if r.Context().Err() != nil {
			return 499, "client_cancelled", false
		}
		writeUpstreamError(w, providers.HTTPInvocationError(prefix, http.StatusBadGateway, []byte("response body could not be read")))
		return http.StatusBadGateway, "upstream_body_read", false
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(response.StatusCode)
	writer := &audioProxyWriter{writer: w}
	_, err := io.Copy(writer, reader)
	if r.Context().Err() != nil || writer.err != nil {
		return 499, "client_cancelled", true
	}
	if err != nil {
		return http.StatusBadGateway, "upstream_body_read", true
	}
	return response.StatusCode, "", false
}
