"""Writes latest.json for the in-app updater from a release's assets and their .sig files.

Each platform build uploads its installer and signature on its own; this runs once they are all
there, so the jobs never race to edit one latest.json. Usage: latest_json.py <tag> <owner/repo>
"""
import json
import subprocess
import sys
from datetime import datetime, timezone

tag, repo = sys.argv[1], sys.argv[2]


def gh(*args):
    return subprocess.check_output(["gh", *args, "--repo", repo], text=True)


names = {a["name"] for a in json.loads(gh("release", "view", tag, "--json", "assets"))["assets"]}
notes = json.loads(gh("release", "view", tag, "--json", "body"))["body"]
platforms = {}

# Updater keys: "<os>-<arch>" is the fallback, "<os>-<arch>-<installer>" wins when it matches how
# the running copy was installed.
for keys, suffix in [
    (["windows-x86_64", "windows-x86_64-nsis"], "-setup.exe"),
    (["darwin-aarch64", "darwin-x86_64", "darwin-aarch64-app", "darwin-x86_64-app"], ".app.tar.gz"),
    (["linux-x86_64", "linux-x86_64-appimage"], ".AppImage"),
    (["linux-x86_64-deb"], ".deb"),
]:
    found = sorted(n for n in names if n.endswith(suffix) and n + ".sig" in names)
    if not found:
        print(f"no signed {suffix} in {tag}", file=sys.stderr)
        continue
    name = found[0]
    signature = gh("release", "download", tag, "--pattern", name + ".sig", "--output", "-")
    for key in keys:
        platforms[key] = {"signature": signature.strip(), "url": f"https://github.com/{repo}/releases/download/{tag}/{name}"}

if "windows-x86_64" not in platforms:
    sys.exit("the Windows installer is missing: not publishing")

json.dump(
    {
        "version": tag.lstrip("v"),
        "notes": notes,
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    },
    open("latest.json", "w"),
    indent=2,
)
print("latest.json:", ", ".join(sorted(platforms)))
