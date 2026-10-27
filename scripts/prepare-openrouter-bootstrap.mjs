/** Prepare only: no publish, login, trust configuration or source version changes. */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const source = JSON.parse(
  await readFile(new URL("../packages/decision-openrouter/package.json", import.meta.url), "utf8"),
);
const directory = await mkdtemp(join(tmpdir(), "dsh-openrouter-bootstrap-"));
const version = "0.0.0-bootstrap.0";
const manifest = {
  name: source.name,
  version,
  description:
    "Initialization package for configuring OpenRouter adapter trusted publishing; contains no adapter runtime.",
  license: source.license,
  repository: source.repository,
  main: "index.cjs",
  files: ["index.cjs", "README.md", "LICENSE"],
  publishConfig: { access: "public", tag: "bootstrap" },
};
const notice =
  "This is an initialization-only package for npm Trusted Publisher setup. It contains no OpenRouter adapter runtime. Install a stable release after the updated decision core and adapter are published.";
await Promise.all([
  writeFile(join(directory, "package.json"), JSON.stringify(manifest, null, 2) + "\n"),
  writeFile(join(directory, "README.md"), `# ${manifest.name}\n\n${notice}\n`),
  writeFile(join(directory, "index.cjs"), `throw new Error(${JSON.stringify(notice)});\n`),
  readFile(new URL("../LICENSE", import.meta.url)).then((license) =>
    writeFile(join(directory, "LICENSE"), license),
  ),
]);
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--json", "--pack-destination", directory],
  {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`);
const filename = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
const tarball = join(directory, filename);
if (!(await stat(tarball)).isFile()) throw new Error("npm pack did not produce a tarball.");
console.log(
  JSON.stringify(
    {
      name: manifest.name,
      version,
      distTag: "bootstrap",
      tarball,
      published: false,
    },
    null,
    2,
  ),
);
