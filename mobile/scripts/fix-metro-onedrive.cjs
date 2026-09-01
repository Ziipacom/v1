// OneDrive placeholder files can have Dirent.isSymbolicLink() === true while
// lstat().isSymbolicLink() === false. Metro otherwise skips real package.json
// files or calls readlink on ordinary files (EINVAL). Verify only ambiguous
// Windows entries with lstat; preserve actual symlinks and non-Windows behavior.
const fs = require("node:fs");
const path = require("node:path");
const target = path.join(
  path.dirname(require.resolve("@expo/metro-file-map")),
  "crawlers",
  "node",
  "index.js",
);
let source = fs.readFileSync(target, "utf8");
if (source.includes("ziipaOneDriveEntry")) process.exit(0);
const before = "const isDirectory = entry.isDirectory();";
const link = "const isSymbolicLink = entry.isSymbolicLink();";
if (!source.includes(before) || !source.includes(link))
  throw new Error(
    "Metro crawler changed. Review the OneDrive compatibility patch before updating it.",
  );
source = source
  .replace(
    before,
    `let ziipaOneDriveEntry = entry;
                    if (process.platform === 'win32' && entry.isSymbolicLink()) {
                        try { ziipaOneDriveEntry = fs.lstatSync(directory + path.sep + name); }
                        catch { continue; }
                    }
                    const isDirectory = ziipaOneDriveEntry.isDirectory();`,
  )
  .replace(link, "const isSymbolicLink = ziipaOneDriveEntry.isSymbolicLink();");
fs.writeFileSync(target, source);
console.log("Applied Metro OneDrive directory-entry compatibility fix.");
