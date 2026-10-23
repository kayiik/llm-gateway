package architecture

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

type releaseWorkflow struct {
	Env  map[string]string     `yaml:"env"`
	Jobs map[string]releaseJob `yaml:"jobs"`
}

type releaseJob struct {
	If    string            `yaml:"if"`
	Uses  string            `yaml:"uses"`
	Needs yaml.Node         `yaml:"needs"`
	Env   map[string]string `yaml:"env"`
	Steps []struct {
		Run string            `yaml:"run"`
		Env map[string]string `yaml:"env"`
	} `yaml:"steps"`
}

func readReleaseWorkflow(t *testing.T, name string) releaseWorkflow {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", ".github", "workflows", name))
	if err != nil {
		t.Fatal(err)
	}
	var workflow releaseWorkflow
	if err := yaml.Unmarshal(data, &workflow); err != nil {
		t.Fatal(err)
	}
	return workflow
}

func releaseAncestors(workflow releaseWorkflow, name string, seen map[string]bool) error {
	if seen[name] {
		return nil
	}
	job, ok := workflow.Jobs[name]
	if !ok {
		return fmt.Errorf("missing release job %s", name)
	}
	seen[name] = true
	var parents []string
	if job.Needs.Kind == yaml.ScalarNode {
		parents = append(parents, job.Needs.Value)
	} else {
		for _, node := range job.Needs.Content {
			parents = append(parents, node.Value)
		}
	}
	for _, parent := range parents {
		if err := releaseAncestors(workflow, parent, seen); err != nil {
			return err
		}
	}
	return nil
}

// Follow reusable workflows too: renaming a live job must not turn a tag push
// back into an implicit provider qualification run.
func providerFreeRelease(workflows map[string]releaseWorkflow, name string, visited map[string]bool) error {
	if visited[name] {
		return nil
	}
	visited[name] = true
	workflow, ok := workflows[name]
	if !ok {
		return fmt.Errorf("unreviewed reusable release workflow %s", name)
	}
	for id, job := range workflow.Jobs {
		if job.Uses != "" {
			if !strings.HasPrefix(job.Uses, "./.github/workflows/") {
				return fmt.Errorf("unreviewed external release workflow %s", job.Uses)
			}
			if err := providerFreeRelease(workflows, strings.TrimPrefix(job.Uses, "./.github/workflows/"), visited); err != nil {
				return err
			}
		}
		for _, step := range job.Steps {
			mode := workflow.Env["LLMGW_ACCEPTANCE_MODE"]
			if value, ok := job.Env["LLMGW_ACCEPTANCE_MODE"]; ok {
				mode = value
			}
			if value, ok := step.Env["LLMGW_ACCEPTANCE_MODE"]; ok {
				mode = value
			}
			if mode == "live" || (strings.Contains(step.Run, "test/live-acceptance/run.mjs") && mode != "deterministic") {
				return fmt.Errorf("release job %s/%s invokes live or unspecified acceptance", name, id)
			}
		}
	}
	return nil
}

func TestReleasePublicationRetainsDeterministicGatesWithoutLiveCalls(t *testing.T) {
	release := readReleaseWorkflow(t, "release.yml")
	ci := readReleaseWorkflow(t, "ci.yml")
	if err := providerFreeRelease(map[string]releaseWorkflow{"release.yml": release, "ci.yml": ci}, "release.yml", map[string]bool{}); err != nil {
		t.Fatal(err)
	}
	for _, publication := range []string{"image-promote", "release-publish"} {
		ancestors := map[string]bool{}
		if err := releaseAncestors(release, publication, ancestors); err != nil {
			t.Fatal(err)
		}
		for _, gate := range []string{"validate", "ci", "binaries", "release-stage", "image-publish"} {
			if !ancestors[gate] {
				t.Errorf("%s no longer waits for %s", publication, gate)
			}
		}
		if publication == "release-publish" && !ancestors["image-promote"] {
			t.Error("release publication no longer waits for validated image promotion")
		}
	}
	for _, name := range []string{"release-stage", "image-publish", "image-promote", "release-publish"} {
		if release.Jobs[name].If != "github.event_name == 'push' && github.ref_type == 'tag'" {
			t.Errorf("%s must remain tag-only; manual dispatch must not publish", name)
		}
	}
}

func TestReleaseProviderBoundaryDetectsRenamedAndNestedLiveCalls(t *testing.T) {
	var nested releaseWorkflow
	if err := yaml.Unmarshal([]byte("jobs:\n  child:\n    uses: ./.github/workflows/live-acceptance.yml\n"), &nested); err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{
		"jobs:\n  renamed:\n    uses: ./.github/workflows/live-acceptance.yml\n",
		"jobs:\n  renamed:\n    uses: ./.github/workflows/nested.yml\n",
		"jobs:\n  renamed:\n    steps:\n      - run: node test/live-acceptance/run.mjs\n        env:\n          LLMGW_ACCEPTANCE_MODE: live\n",
		"jobs:\n  renamed:\n    steps:\n      - run: node test/live-acceptance/run.mjs\n",
	} {
		var workflow releaseWorkflow
		if err := yaml.Unmarshal([]byte(source), &workflow); err != nil {
			t.Fatal(err)
		}
		workflows := map[string]releaseWorkflow{"release.yml": workflow, "nested.yml": nested}
		if err := providerFreeRelease(workflows, "release.yml", map[string]bool{}); err == nil {
			t.Errorf("unsafe release invocation accepted: %s", source)
		}
	}
}
