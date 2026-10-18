import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const consoleDir = join(root, 'go/internal/web/console');
const policyTests = 'TestNativePolicy|TestCompatibilityHeaderValidation|TestAdminRouteContract|TestInferenceRejectsTrailingJSONBeforeAnyCall|TestRouteIngressRestricts|TestPlaygroundPreparedPolicyParity|TestPlaygroundRejectsRestrictiveTargetSubsetBeforeQuota|TestTransparentResponsesPreservesUpstreamInstructions|TestNativeMessagesStream|TestMixedMessagesStreamKeepsNativeMembersNative|TestResponsesPreparedConversion|TestSourceUsage|TestStreamUsageIsReportedOrEstimated|TestCodingStreamWriteAndFlushFailuresCloseUpstream|TestChatToolFinishStreamContract';
const inputTemplate = '{{if .Module}}{{if or .Module.Main .Module.Replace}}{{.Dir}}|{{.Module.GoMod}}|{{join .GoFiles ","}}|{{join .CgoFiles ","}}|{{join .TestGoFiles ","}}|{{join .XTestGoFiles ","}}|{{join .EmbedFiles ","}}|{{join .TestEmbedFiles ","}}|{{join .XTestEmbedFiles ","}}|{{join .SFiles ","}}|{{join .SysoFiles ","}}|{{join .CFiles ","}}|{{join .HFiles ","}}{{end}}{{end}}';
const goBuildEnvKeys = ['GOVERSION', 'GOROOT', 'GOTOOLDIR', 'GOOS', 'GOARCH', 'GOEXPERIMENT', 'GOAMD64', 'GO386', 'GOARM', 'GOARM64', 'GOMIPS', 'GOMIPS64', 'GOPPC64', 'GORISCV64', 'GOWASM', 'GOFIPS140', 'CGO_ENABLED', 'CC', 'CXX', 'CGO_CFLAGS', 'CGO_CPPFLAGS', 'CGO_CXXFLAGS', 'CGO_FFLAGS', 'CGO_LDFLAGS', 'PKG_CONFIG'];

export function goBuildVariant(goEnv) {
  return Object.fromEntries(goBuildEnvKeys.map(key => [key, goEnv[key] ?? '']));
}

export function isolatedTestEnvironment(original, goEnv, sandbox, state) {
  const env = { ...original, ...goEnv, HOME: sandbox, USERPROFILE: sandbox, APPDATA: join(sandbox, 'AppData/Roaming'), LOCALAPPDATA: join(sandbox, 'AppData/Local'), XDG_CONFIG_HOME: sandbox, XDG_CACHE_HOME: sandbox, GOMAXPROCS: '2', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' };
  for (const key of Object.keys(env)) if (key.startsWith('LLMGW_')) delete env[key];
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.AWS_PROFILE;
  delete env.AWS_SHARED_CREDENTIALS_FILE;
  env.LLMGW_STATE_DIR = state;
  env.LLMGW_CONFIG = join(state, 'config.yaml');
  return env;
}

export function selectedTestResult(result, required) {
  if (!required) return result;
  const tests = (result.output.match(/^=== RUN /gm) || []).length;
  if (tests === 0 && result.code === 0) return { ...result, tests, code: 1, output: result.output + '\nNo tests matched the selected filter.\n' };
  return { ...result, tests };
}

export async function fingerprintInputs(listing, bindings) {
  const paths = new Set();
  for (const line of listing.trim().split(/\r?\n/).filter(Boolean)) {
    const [dir, mod, ...groups] = line.split('|');
    if (mod) paths.add(mod);
    for (const name of groups.flatMap(group => group.split(',')).filter(Boolean)) paths.add(isAbsolute(name) ? name : join(dir, name));
  }
  const hash = createHash('sha256').update(bindings);
  for (const path of [...paths].sort()) {
    hash.update(path + '\0').update(await readFile(path)).update('\0');
    if (path.endsWith('.mod')) {
      try { hash.update(await readFile(path.slice(0, -4) + '.sum')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return hash.digest('hex');
}

// Wait for the owned process, not pipes inherited by a descendant. A successful
// test line alone never overrides a nonzero exit or a runner timeout.
export function runProcess(command, args, { cwd, env, timeout = 180_000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32' });
    const output = [];
    let timedOut = false;
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => output.push(chunk));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, timeout);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        resolveResult({ code: timedOut ? 124 : code ?? 1, signal, timedOut, output: Buffer.concat(output).toString() });
      }, 25);
    });
  });
}

function options(argv) {
  const result = { profile: 'policy', go: process.env.LLMGW_TEST_GO || 'go', modfile: process.env.LLMGW_TEST_MODFILE, repeat: '1', timeout: 180_000, artifacts: process.env.LLMGW_TEST_ARTIFACTS || tmpdir() };
  if (argv[0] && !argv[0].startsWith('--')) result.profile = argv.shift();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    if (!['--go', '--modfile', '--run', '--package', '--repeat', '--timeout', '--artifacts'].includes(flag) || !argv[index + 1]) throw new Error(`Invalid option: ${flag}`);
    result[flag.slice(2)] = argv[++index];
  }
  if (!['policy', 'api', 'go', 'console', 'all'].includes(result.profile)) throw new Error('Choose policy, api, go, console, or all.');
  if (result.package && (result.profile !== 'go' || result.package.startsWith('-'))) throw new Error('--package selects a package for the go profile.');
  if (!/^[1-9]\d*$/.test(result.repeat)) throw new Error('--repeat must be a positive integer.');
  result.timeout = Number(result.timeout);
  if (!Number.isSafeInteger(result.timeout) || result.timeout < 100) throw new Error('--timeout must be milliseconds (at least 100).');
  if (result.modfile) result.modfile = resolve(result.modfile);
  return result;
}

export async function main(argv) {
  const opts = options([...argv]);
  if (opts.help) {
    console.log('node scripts/test-local.mjs [policy|api|go|console|all] [--modfile PATH] [--go PATH] [--run REGEX] [--package GO_PACKAGE] [--repeat N] [--timeout MS] [--artifacts DIRECTORY]');
    return 0;
  }
  await mkdir(resolve(opts.artifacts), { recursive: true });
  const artifacts = await mkdtemp(join(resolve(opts.artifacts), 'llmgw-test-'));
  console.log(`Artifacts: ${artifacts}`);
  const sandbox = join(artifacts, 'home');
  const state = join(artifacts, 'state');
  await Promise.all([mkdir(join(sandbox, 'AppData/Roaming'), { recursive: true }), mkdir(join(sandbox, 'AppData/Local'), { recursive: true }), mkdir(state)]);
  const results = [];
  async function check(name, command, args, cwd, env = process.env) {
    const started = performance.now();
    const result = selectedTestResult(await runProcess(command, args, { cwd, env, timeout: opts.timeout }), name === 'api-tests' || ((name === 'go-all' || name === 'go-package') && Boolean(opts.run)));
    const { tests } = result;
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    await writeFile(join(artifacts, `${name}.log`), result.output);
    results.push({ name, code: result.code, timedOut: result.timedOut, seconds: Number(seconds), tests });
    console.log(`${result.code === 0 ? 'PASS' : result.timedOut ? 'TIMEOUT' : 'FAIL'} ${name} (${seconds}s${tests === undefined ? '' : `, ${tests} tests/subtests`})`);
    if (result.code !== 0) {
      const failures = name === 'api-tests' ? result.output.split(/\r?\n/).filter(line => /^\s*(--- FAIL:|[\w.-]+_test\.go:\d+:)/.test(line)) : [];
      console.log(failures.length ? failures.join('\n') : result.output);
    }
    return result;
  }
  try {
    if (['policy', 'api', 'go', 'all'].includes(opts.profile)) {
      // Resolve caches before changing HOME, so isolation does not cold-start Go.
      const original = { ...process.env, GOWORK: 'off', GOFLAGS: '' };
      const cache = await runProcess(opts.go, ['env', '-json', 'GOPATH', 'GOMODCACHE', 'GOCACHE', ...goBuildEnvKeys], { cwd: join(root, 'go'), env: original, timeout: opts.timeout });
      if (cache.code !== 0) throw new Error(`Cannot resolve Go caches: ${cache.output}`);
      const goEnv = JSON.parse(cache.output);
      const env = isolatedTestEnvironment(original, goEnv, sandbox, state);
      const modArgs = opts.modfile ? ['-modfile=' + opts.modfile, '-mod=mod'] : ['-mod=readonly'];
      const testTimeout = Math.max(1, Math.floor(opts.timeout / 1000) - 5) + 's';
      if (opts.profile === 'policy' || opts.profile === 'api') {
        const inputs = await check('api-inputs', opts.go, ['list', ...modArgs, '-deps', '-test', '-f', inputTemplate, './internal/api'], join(root, 'go'), env);
        if (inputs.code === 0) {
          const binding = JSON.stringify({ go: opts.go, toolchain: goBuildVariant(goEnv), mod: opts.modfile ? await readFile(opts.modfile, 'utf8') : await readFile(join(root, 'go/go.mod'), 'utf8') });
          const fingerprint = await fingerprintInputs(inputs.output, binding);
          const buildDir = join(resolve(opts.artifacts), 'llmgw-build-cache');
          await mkdir(buildDir, { recursive: true });
          const binary = join(buildDir, fingerprint + (process.platform === 'win32' ? '.test.exe' : '.test'));
          let ready = false;
          try { await access(binary); ready = await readFile(binary + '.ready', 'utf8') === fingerprint; } catch { /* Build a new exact-input artifact. */ }
          if (ready) console.log('REUSE api-build');
          else {
            const build = await check('api-build', opts.go, ['test', '-c', '-vet=off', '-p=1', ...modArgs, '-o', binary, './internal/api'], join(root, 'go'), env);
            ready = build.code === 0;
            if (ready) {
              const current = await runProcess(opts.go, ['list', ...modArgs, '-deps', '-test', '-f', inputTemplate, './internal/api'], { cwd: join(root, 'go'), env, timeout: opts.timeout });
              if (current.code === 0 && await fingerprintInputs(current.output, binding) === fingerprint) await writeFile(binary + '.ready', fingerprint);
              else console.log('Source changed during build; this executable will not be cached.');
            }
          }
          if (ready) {
            const args = ['-test.v=true', '-test.count=' + opts.repeat, '-test.timeout=' + testTimeout];
            if (opts.run || opts.profile === 'policy') args.push('-test.run=' + (opts.run || policyTests));
            await check('api-tests', binary, args, join(root, 'go/internal/api'), env);
          }
        }
      } else {
        const args = ['test', '-count=' + opts.repeat, '-p=1', '-timeout=' + testTimeout, ...modArgs];
        if (opts.run) args.push('-v', '-run=' + opts.run);
        await check(opts.package ? 'go-package' : 'go-all', opts.go, [...args, opts.package || './...'], join(root, 'go'), env);
      }
    }
    if (opts.profile === 'console' || opts.profile === 'all') {
      await check('console-types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], consoleDir);
      await check('console-tests', process.execPath, ['--test', 'tests/*.test.mjs'], consoleDir);
    }
    if (opts.profile === 'all') await check('docs', process.execPath, ['scripts/check-docs.mjs'], root);
  } finally {
    await writeFile(join(artifacts, 'results.json'), JSON.stringify({ profile: opts.profile, package: opts.package, results }, null, 2) + '\n');
    console.log(`Results: ${artifacts}`);
  }
  return results.some(result => result.code !== 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
