// Node glob misidentifies some OneDrive placeholder directories as symbolic
// links and skips the existing Android entry points. Use lstat only for the
// Windows fallback; do not change real symlink handling or other platforms.
const fs = require("node:fs");
const path = require("node:path");
const target = path.join(path.dirname(require.resolve("@expo/config-plugins/package.json")), "build/android/Paths.js");
let source = fs.readFileSync(target, "utf8");
if (source.includes("ziipaOneDriveAndroidEntry")) process.exit(0);
const before = "  const filePath = (0, _glob().globSync)(`android/app/src/main/java/**/${name}.@(java|kt)`, {\n    cwd: projectRoot,\n    absolute: true\n  })[0];";
if (!source.includes(before)) throw new Error("Expo Android paths changed. Review the OneDrive fallback before updating.");
source = source.replace(before, before.replace("const filePath", "let filePath") + `
  if (!filePath && process.platform === 'win32') {
    const fs = require('node:fs');
    const matches = [];
    function ziipaOneDriveAndroidEntry(directory) {
      for (const nameInDirectory of fs.readdirSync(directory)) {
        const candidate = path().join(directory, nameInDirectory);
        const stat = fs.lstatSync(candidate);
        if (stat.isDirectory()) ziipaOneDriveAndroidEntry(candidate);
        else if (stat.isFile() && [name + '.kt', name + '.java'].includes(nameInDirectory)) matches.push(candidate);
      }
    }
    const javaRoot = path().join(projectRoot, 'android/app/src/main/java');
    if (fs.existsSync(javaRoot)) ziipaOneDriveAndroidEntry(javaRoot);
    if (matches.length === 1) filePath = matches[0];
  }`);
fs.writeFileSync(target, source);
console.log("Applied Expo prebuild OneDrive entry-point compatibility fix.");
