"""Package the Chrome extension for the team.

    python pack_extension.py

Writes the same zip to two places:
  superprofile-crm-extension.zip                       (here, for sharing by hand)
  cloud/static/downloads/superprofile-crm-extension.zip (served by the CRM — the
                                                       sidebar's "Chrome extension")
and cloud/static/downloads/extension.json with the version, which the installed
extension checks to tell people when they are behind. Deploy the worker after
running this so the CRM serves the new copy.

Bump "version" in extension/manifest.json first: the update notice compares it.
"""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "extension")
DL = os.path.join(ROOT, "cloud", "static", "downloads")
NAME = "superprofile-crm-extension.zip"

version = json.load(open(os.path.join(SRC, "manifest.json"), encoding="utf-8"))["version"]
os.makedirs(DL, exist_ok=True)
for out in (os.path.join(ROOT, NAME), os.path.join(DL, NAME)):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(os.listdir(SRC)):
            p = os.path.join(SRC, f)
            if os.path.isfile(p):
                z.write(p, "superprofile-crm-extension/" + f)
with open(os.path.join(DL, "extension.json"), "w", encoding="utf-8") as fh:
    json.dump({"version": version, "zip": "/downloads/" + NAME, "guide": "/downloads/INSTALL.txt"}, fh)
# The install guide, readable straight from the CRM.
with open(os.path.join(SRC, "INSTALL.md"), encoding="utf-8") as a, open(os.path.join(DL, "INSTALL.txt"), "w", encoding="utf-8") as b:
    b.write(a.read())
print("packed extension v%s -> %s and %s" % (version, NAME, os.path.relpath(DL, ROOT)))
