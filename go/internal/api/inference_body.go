package api

import (
	"encoding/json"
	"errors"
	"io"
)

// Decode the whole bounded document before routing. A valid first object must
// not hide another request or an oversized suffix, and native numbers stay exact.
func decodeInferenceBody(reader io.Reader, target any) error {
	decoder := json.NewDecoder(reader)
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err != nil {
			return err
		}
		return errors.New("only one JSON request document is allowed")
	}
	return nil
}
