import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const optionByExecutable = new Map();

export function filterGraphFileOption(helpText) {
  const help = String(helpText || "");
  if (/^\s*-filter_complex\b/m.test(help)) return "-filter_complex";
  throw new Error("This FFmpeg build has no supported complex filtergraph option.");
}

export async function filterGraphFileArgs(executable, path) {
  if (!optionByExecutable.has(executable)) {
    optionByExecutable.set(executable, new Promise((resolve, reject) => {
      const child = spawn(executable, ["-h", "full"], { windowsHide: true, shell: false });
      let output = "";
      const collect = chunk => { output = `${output}${chunk}`.slice(0, 2_000_000); };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", reject);
      child.on("close", code => code === 0
        ? resolve(filterGraphFileOption(output))
        : reject(new Error(`FFmpeg capability check exited with code ${code}.`)));
    }).catch(error => {
      optionByExecutable.delete(executable);
      throw error;
    }));
  }
  const option = await optionByExecutable.get(executable);
  // The full build used by this project exposes only -filter_complex. Passing
  // a filename to that option makes FFmpeg parse the path as a graph; read the
  // graph here and pass its contents instead. This also avoids the unsupported
  // /filter_complex and -filter_complex_script variants on FFmpeg 9.
  return [option, await readFile(path, "utf8")];
}
