package config

import (
	"fmt"
	"slices"
	"strings"
)

const (
	maxExpandedEndpointMembers = 4096
	maxEndpointReferenceDepth  = 128
)

// ExpandEndpointMembers expands reusable member lists, not child route policy.
// The caller retains the requested route's ingress, adaptation and grant boundary.
// Names resolve exactly first, otherwise by a unique case-insensitive match.
// Order, duplicates and leaf flags are preserved; source settings are untouched.
// Expansion is bounded to 4096 leaves and 128 nested routes per requested route.
func ExpandEndpointMembers(endpoints map[string]*EndpointConfig, name string) ([]EndpointMember, error) {
	e := endpointExpander{endpoints: endpoints, active: map[string]bool{}, memo: map[string][]EndpointMember{}, heights: map[string]int{}}
	members, err := e.expand(name, 0)
	return slices.Clone(members), err
}

// ValidateEndpointReferences checks only the member graph, not provider/catalog
// availability or child policy. Empty legacy routes are valid member lists.
func ValidateEndpointReferences(endpoints map[string]*EndpointConfig) error {
	names := make([]string, 0, len(endpoints))
	for name := range endpoints {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		if _, err := ExpandEndpointMembers(endpoints, name); err != nil {
			return err
		}
	}
	return nil
}

type endpointExpander struct {
	endpoints map[string]*EndpointConfig
	active    map[string]bool
	memo      map[string][]EndpointMember
	heights   map[string]int
}

func (e *endpointExpander) resolve(name string) (string, error) {
	if _, ok := e.endpoints[name]; ok {
		return name, nil
	}
	match, found := "", false
	for candidate := range e.endpoints {
		if strings.EqualFold(candidate, name) {
			if found {
				return "", fmt.Errorf("route reference %q is ambiguous", name)
			}
			match, found = candidate, true
		}
	}
	if !found {
		return "", fmt.Errorf("route reference %q is missing", name)
	}
	return match, nil
}

func (e *endpointExpander) expand(name string, depth int) ([]EndpointMember, error) {
	name, err := e.resolve(name)
	if err != nil {
		return nil, err
	}
	if e.active[name] {
		return nil, fmt.Errorf("route reference cycle at %q", name)
	}
	if depth >= maxEndpointReferenceDepth {
		return nil, fmt.Errorf("route %q exceeds %d nested routes", name, maxEndpointReferenceDepth)
	}
	// Memoizing empty lists as well prevents exponential walks through empty DAGs.
	if members, ok := e.memo[name]; ok {
		if depth+e.heights[name] > maxEndpointReferenceDepth {
			return nil, fmt.Errorf("route %q exceeds %d nested routes", name, maxEndpointReferenceDepth)
		}
		return members, nil
	}
	endpoint := e.endpoints[name]
	if endpoint == nil {
		return nil, fmt.Errorf("route %q definition is missing", name)
	}
	e.active[name] = true
	defer delete(e.active, name)
	var out []EndpointMember
	height := 1
	for i, member := range endpoint.Failover {
		members := []EndpointMember{member}
		if member.Route != "" {
			if member.Provider != "" || member.Model != "" || member.AllowUnverified {
				return nil, fmt.Errorf("route %q member %d mixes route and leaf fields", name, i+1)
			}
			members, err = e.expand(member.Route, depth+1)
			if err != nil {
				return nil, fmt.Errorf("route %q member %d: %w", name, i+1, err)
			}
			child, _ := e.resolve(member.Route) // expand already resolved this name.
			height = max(height, 1+e.heights[child])
		}
		if len(members) > maxExpandedEndpointMembers-len(out) {
			return nil, fmt.Errorf("route %q exceeds %d expanded members", name, maxExpandedEndpointMembers)
		}
		out = append(out, members...)
	}
	e.memo[name] = out
	e.heights[name] = height
	return out, nil
}
