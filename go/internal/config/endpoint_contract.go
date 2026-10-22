package config

import "errors"

// ValidateEndpointContract checks only the explicit ingress/adaptation policy;
// member references retain their existing configuration and API validation.
func ValidateEndpointContract(endpoint *EndpointConfig) error {
	if endpoint == nil {
		return errors.New("route definition is missing")
	}
	seen := make(map[string]bool, len(endpoint.Ingress))
	for _, ingress := range endpoint.Ingress {
		switch ingress {
		case "/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens",
			"/v1/embeddings", "/v1/audio/transcriptions", "/v1/audio/speech", "/v1/images/generations", "/v1/videos/generations", "/v1/realtime/calls", "/v1/realtime":
		default:
			return errors.New("route ingress must name a canonical inference API path")
		}
		if seen[ingress] {
			return errors.New("route ingress paths must be unique")
		}
		seen[ingress] = true
	}
	if endpoint.AllowAdaptation && len(endpoint.Ingress) == 0 {
		return errors.New("route adaptation requires an explicit ingress declaration")
	}
	return nil
}
